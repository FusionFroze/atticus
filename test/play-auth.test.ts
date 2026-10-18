import { afterEach, describe, expect, it } from "vitest";
import { base64UrlToBytes } from "../src/lib/base64url";
import { createBudget } from "../src/lib/budget";
import { pemToPkcs8 } from "../src/lib/pem";
import {
  clearTokenCache,
  getAccessToken,
  signServiceAccountJwt,
} from "../src/sources/play/auth";

const EMAIL = "atticus-test@example.iam.gserviceaccount.com";

afterEach(() => {
  clearTokenCache();
});

describe("service account JWT", () => {
  it("signs a header and claims that the public key can verify", async () => {
    const { pem, publicKey } = await generateKey();
    const nowSeconds = 1_700_000_000;
    const jwt = await signServiceAccountJwt(
      { clientEmail: EMAIL, privateKeyPem: pem },
      nowSeconds,
    );

    const parts = jwt.split(".");
    const headerPart = parts[0];
    const payloadPart = parts[1];
    const signaturePart = parts[2];
    expect(headerPart).toBeTruthy();
    expect(payloadPart).toBeTruthy();
    expect(signaturePart).toBeTruthy();
    if (!headerPart || !payloadPart || !signaturePart) return;

    expect(
      JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart))),
    ).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(
      JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart))),
    ).toEqual({
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    });

    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5" },
      publicKey,
      base64UrlToBytes(signaturePart),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    );
    expect(verified).toBe(true);
    expect(pemToPkcs8(pem).byteLength).toBeGreaterThan(0);
  });
});

describe("access token cache", () => {
  it("reuses a token until five minutes before expiry, then signs again", async () => {
    const { pem } = await generateKey();
    const credentials = { clientEmail: EMAIL, privateKeyPem: pem };
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = ((line: unknown) => {
      logs.push(String(line));
    }) as typeof console.log;

    const calls: string[] = [];
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      calls.push(request.url);
      const body = new TextDecoder().decode(await request.arrayBuffer());
      expect(body).toContain(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer",
      );
      expect(body).toContain("assertion=");
      return Response.json({
        access_token: "ya29.not-a-real-token",
        expires_in: 3600,
        token_type: "Bearer",
      });
    }) as typeof fetch;

    try {
      const now = 1_700_000_000_000;
      const budget = createBudget(now);
      const first = await getAccessToken(credentials, budget, now);
      const reused = await getAccessToken(
        credentials,
        budget,
        now + 54 * 60 * 1000,
      );
      const refreshed = await getAccessToken(
        credentials,
        budget,
        now + 55 * 60 * 1000,
      );

      expect(first).toEqual({ ok: true, token: "ya29.not-a-real-token" });
      expect(reused).toEqual(first);
      expect(refreshed.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(budget.remaining()).toBe(43);
      expect(logs).toHaveLength(2);
      expect(logs.every((line) => line === '{"event":"token_refreshed"}')).toBe(
        true,
      );
      expect(logs.join("\n")).not.toContain("ya29.not-a-real-token");
    } finally {
      console.log = originalLog;
      globalThis.fetch = previousFetch;
    }
  });

  it("refreshes when the service account email changes", async () => {
    const { pem } = await generateKey();
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({
        access_token: `token-${calls}`,
        expires_in: 3600,
      });
    }) as typeof fetch;

    try {
      const now = 1_700_000_000_000;
      const budget = createBudget(now);
      await getAccessToken(
        { clientEmail: EMAIL, privateKeyPem: pem },
        budget,
        now,
      );
      await getAccessToken(
        {
          clientEmail: "other@example.iam.gserviceaccount.com",
          privateKeyPem: pem,
        },
        budget,
        now,
      );
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("maps a failed exchange, a bad body and a thrown fetch to auth", async () => {
    const { pem } = await generateKey();
    const credentials = { clientEmail: EMAIL, privateKeyPem: pem };
    const now = 1_700_000_000_000;
    const responses = [
      () => new Response("nope", { status: 401 }),
      () => Response.json({ token_type: "Bearer" }),
      () => {
        throw new TypeError("network down");
      },
    ];

    const previousFetch = globalThis.fetch;
    try {
      for (const respond of responses) {
        clearTokenCache();
        globalThis.fetch = (async () => respond()) as typeof fetch;
        const result = await getAccessToken(
          credentials,
          createBudget(now),
          now,
        );
        expect(result).toEqual({ ok: false, failure: { kind: "auth" } });
      }
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not fetch when the budget is spent or the key cannot be imported", async () => {
    let calls = 0;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ access_token: "unused", expires_in: 3600 });
    }) as typeof fetch;

    try {
      const now = 1_700_000_000_000;
      const spent = await getAccessToken(
        { clientEmail: EMAIL, privateKeyPem: testPem() },
        createBudget(now, 0),
        now,
      );
      expect(spent).toEqual({ ok: false, failure: { kind: "budget" } });

      const broken = await getAccessToken(
        {
          clientEmail: EMAIL,
          privateKeyPem:
            "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
        },
        createBudget(now),
        now,
      );
      expect(broken).toEqual({ ok: false, failure: { kind: "auth" } });
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

function testPem(): string {
  return "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";
}

async function generateKey(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair)) throw new Error("expected an RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer))
    throw new Error("expected PKCS#8 bytes");
  return { pem: wrapPem(new Uint8Array(exported)), publicKey: pair.publicKey };
}

function wrapPem(pkcs8: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < pkcs8.length; index++) {
    binary += String.fromCharCode(pkcs8[index] ?? 0);
  }
  const encoded = btoa(binary);
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 64) {
    lines.push(encoded.slice(index, index + 64));
  }
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
