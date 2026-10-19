import {
  createExecutionContext,
  createScheduledController,
  env as testEnv,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { clearTokenCache } from "../src/sources/play/auth";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";

afterEach(() => {
  clearTokenCache();
});

describe("worker", () => {
  it("binds placeholder secrets, never the ones in .dev.vars", () => {
    const bound = testEnv as unknown as Record<string, unknown>;
    expect(bound.GOOGLE_SERVICE_ACCOUNT_JSON).toBe("test-placeholder");
    expect(bound.DISCORD_BOT_TOKEN).toBe("test-placeholder");
  });

  it("answers every route with an empty 404", async () => {
    for (const path of ["/", "/interactions", "/reviews"]) {
      const response = await worker.fetch(
        new Request(`https://atticus.test${path}`),
        validEnv() as Env,
        createExecutionContext(),
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("");
    }
  });

  it("answers a POST to any other path with an empty 404", async () => {
    const response = await worker.fetch(
      new Request("https://atticus.test/other", { method: "POST" }),
      validEnv() as Env,
      createExecutionContext(),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });

  it("logs config_invalid and does not call Google when a var is missing", async () => {
    const { lines, restore } = captureLog();
    let fetches = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response("nope");
    }) as typeof fetch;

    try {
      const env = validEnv();
      delete env.DISCORD_CHANNEL_ID;
      await worker.scheduled(
        createScheduledController(),
        env as Env,
        createExecutionContext(),
      );
      expect(fetches).toBe(0);
      expect(lines).toHaveLength(1);
      const event = JSON.parse(lines[0] ?? "{}") as {
        event?: string;
        errors?: string[];
      };
      expect(event.event).toBe("config_invalid");
      expect(event.errors?.join("\n")).toContain(
        "`DISCORD_CHANNEL_ID` is missing. Set it in wrangler.jsonc → vars (README → Discord setup).",
      );
    } finally {
      restore();
      globalThis.fetch = previous;
    }
  });

  it("names a bad service-account field and does not echo the key", async () => {
    const marker = "UNIQUE_KEY_MATERIAL_z9Q";
    const { lines, restore } = captureLog();
    try {
      const env = validEnv();
      env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: "atticus@example.iam.gserviceaccount.com",
        private_key: marker,
      });
      await worker.scheduled(
        createScheduledController(),
        env as Env,
        createExecutionContext(),
      );
      const text = lines.join("\n");
      expect(text).toContain("private_key");
      expect(text).not.toContain(marker);
      expect(text).not.toContain("BEGIN PRIVATE KEY");
    } finally {
      restore();
    }
  });

  it("logs review ids only, and reuses the token on a second run", async () => {
    const pem = await generatePem();
    const { lines, restore } = captureLog();
    let tokenCalls = 0;
    let discordCalls = 0;
    const previous = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const request = new Request(input, init);
      const origin = new URL(request.url).origin;
      if (origin === "https://oauth2.googleapis.com") {
        tokenCalls += 1;
        return Response.json({
          access_token: "ya29.TEST_TOKEN_SHOULD_NOT_LOG",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }
      if (origin === "https://discord.com") {
        discordCalls += 1;
        return Response.json({ id: String(discordCalls) });
      }
      return Response.json({
        reviews: [
          {
            reviewId: "review-1",
            authorName: "Should Not Log Author",
            comments: [
              {
                userComment: {
                  text: "Should Not Log Body",
                  starRating: 2,
                  lastModified: { seconds: "1700000000" },
                },
              },
            ],
          },
        ],
      });
    }) as typeof fetch;

    try {
      await testEnv.DB.batch([
        testEnv.DB.prepare("DELETE FROM messages"),
        testEnv.DB.prepare("DELETE FROM outbox"),
        testEnv.DB.prepare("DELETE FROM reviews"),
        testEnv.DB.prepare("DELETE FROM state"),
      ]);
      const env = validEnv();
      env.DB = testEnv.DB;
      env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
        client_email: "atticus@example.iam.gserviceaccount.com",
        private_key: pem,
      });
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController(), env as Env, ctx);
      await worker.scheduled(createScheduledController(), env as Env, ctx);

      expect(tokenCalls).toBe(1);
      expect(discordCalls).toBe(2);
      const sent = await testEnv.DB.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'",
      ).first<{ n: number }>();
      expect(sent).toEqual({ n: 2 });
      const text = lines.join("\n");
      expect(text).not.toContain("Should Not Log Author");
      expect(text).not.toContain("Should Not Log Body");
      expect(text).not.toContain("ya29.TEST_TOKEN_SHOULD_NOT_LOG");
      expect(text).not.toContain("BEGIN PRIVATE KEY");
      const events = lines.map(
        (line) => JSON.parse(line) as { event: string; reviewIds?: string[] },
      );
      expect(
        events.filter((event) => event.event === "token_refreshed"),
      ).toHaveLength(1);
      expect(events.filter((event) => event.event === "poll_app")).toEqual([
        {
          event: "poll_app",
          appId: "com.fusionfroze.Lune",
          count: 1,
          reviewIds: ["review-1"],
        },
        {
          event: "poll_app",
          appId: "com.fusionfroze.Lune",
          count: 1,
          reviewIds: ["review-1"],
        },
      ]);
    } finally {
      restore();
      globalThis.fetch = previous;
    }
  });
});

function validEnv(): Record<string, unknown> {
  return {
    APPS: [{ store: "play", id: "com.fusionfroze.Lune", name: "Lune" }],
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "atticus@example.iam.gserviceaccount.com",
      private_key: PEM,
    }),
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_PUBLIC_KEY: "ab".repeat(32),
    DISCORD_CHANNEL_ID: "223456789012345678",
    ALLOWED_USER_IDS: "323456789012345678",
  };
}

function captureLog(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.log;
  return {
    lines,
    restore: () => {
      console.log = original;
    },
  };
}

async function generatePem(): Promise<string> {
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
  const pkcs8 = new Uint8Array(exported);
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
