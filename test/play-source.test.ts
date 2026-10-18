import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { createBudget } from "../src/lib/budget";
import { clearTokenCache } from "../src/sources/play/auth";
import { createPlaySource } from "../src/sources/play/source";
import type { ReviewSource } from "../src/sources/types";
import malformed from "./fixtures/play/malformed.json";
import page1 from "./fixtures/play/page-1.json";
import page2 from "./fixtures/play/page-2.json";

const APP_ID = "com.fusionfroze.Lune";
const EMAIL = "atticus-test@example.iam.gserviceaccount.com";
const ACCESS_TOKEN = "ya29.SOURCE_TEST_TOKEN";

const app: AppConfig = {
  store: "play",
  id: APP_ID,
  name: "Lune",
  consoleUrl: null,
};

let restoreFetch: (() => void) | null = null;
let pemPromise: Promise<string> | null = null;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = null;
  clearTokenCache();
});

describe("listRecent", () => {
  it("follows pages and returns normalised reviews", async () => {
    const calls = installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      const token = new URL(request.url).searchParams.get("token");
      if (token === null) return Response.json(page1);
      if (token === "page-2") return Response.json(page2);
      return Response.json({ reviews: [] });
    });
    const { lines, restore } = captureLog();

    try {
      const result = await (await playSource("en")).listRecent(
        app,
        createBudget(0),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.truncated).toBe(false);
      expect(result.reviews.map((review) => review.reviewId)).toEqual([
        "review-full",
        "review-translated",
        "review-minimal",
        "review-page-2",
      ]);
      expect(result.reviews[0]).toMatchObject({
        title: "Night mode",
        body: "The lamp stays on after sunrise.",
        device: "Sample Phone",
        osVersion: "34",
        appId: APP_ID,
      });
      expect(result.reviews[3]).toMatchObject({
        title: null,
        device: "fallback-device",
      });

      const playCalls = calls.filter((call) => call.url.includes("/reviews"));
      expect(playCalls).toHaveLength(2);
      expect(
        playCalls.map((call) => new URL(call.url).searchParams.get("token")),
      ).toEqual([null, "page-2"]);
      expect(
        playCalls.every(
          (call) =>
            new URL(call.url).searchParams.get("translationLanguage") ===
              "en" &&
            call.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`,
        ),
      ).toBe(true);
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { event: "token_refreshed" },
      ]);
      expect(lines.join("\n")).not.toContain(ACCESS_TOKEN);
    } finally {
      restore();
    }
  });

  it("logs a malformed review and still returns the valid ones", async () => {
    installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      return Response.json({
        reviews: [
          {
            reviewId: "review-ok",
            comments: [
              {
                userComment: {
                  text: "Kept body",
                  lastModified: { seconds: "1700000000" },
                  starRating: 5,
                },
              },
            ],
          },
          malformed.reviews[0],
        ],
      });
    });
    const { lines, restore } = captureLog();

    try {
      const result = await (await playSource(null)).listRecent(
        app,
        createBudget(0),
      );
      expect(result).toMatchObject({
        ok: true,
        truncated: false,
        reviews: [{ reviewId: "review-ok", body: "Kept body" }],
      });
      expect(events(lines)).toEqual([
        { event: "token_refreshed" },
        {
          event: "review_malformed",
          appId: APP_ID,
          reviewId: "review-rating-0",
          reason: "rating",
        },
      ]);
      expect(lines.join("\n")).not.toContain("Zero stars.");
      expect(lines.join("\n")).not.toContain(ACCESS_TOKEN);
    } finally {
      restore();
    }
  });

  it("logs each skipped review from the malformed fixture and returns none", async () => {
    installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      return Response.json(malformed);
    });
    const { lines, restore } = captureLog();

    try {
      const result = await (await playSource(null)).listRecent(
        app,
        createBudget(0),
      );
      expect(result).toEqual({ ok: true, reviews: [], truncated: false });
      expect(events(lines)).toEqual([
        { event: "token_refreshed" },
        {
          event: "review_malformed",
          appId: APP_ID,
          reviewId: "review-rating-0",
          reason: "rating",
        },
        {
          event: "review_malformed",
          appId: APP_ID,
          reviewId: "review-rating-6",
          reason: "rating",
        },
        {
          event: "review_malformed",
          appId: APP_ID,
          reviewId: "review-no-modified",
          reason: "last_modified",
        },
      ]);
      const text = lines.join("\n");
      expect(text).not.toContain("Zero stars.");
      expect(text).not.toContain("Six stars.");
      expect(text).not.toContain("No timestamp.");
    } finally {
      restore();
    }
  });

  it("returns a Play failure and does not log the response body", async () => {
    installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      return new Response("play-error-body-should-not-log", { status: 403 });
    });
    const { lines, restore } = captureLog();

    try {
      const forbidden = await (await playSource(null)).listRecent(
        app,
        createBudget(0),
      );
      expect(forbidden).toEqual({ ok: false, failure: { kind: "forbidden" } });
      expect(events(lines)).toEqual([{ event: "token_refreshed" }]);
      expect(lines.join("\n")).not.toContain("play-error-body-should-not-log");
    } finally {
      restore();
    }

    installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      throw new TypeError("network down");
    });
    expect(
      await (await playSource(null)).listRecent(app, createBudget(0)),
    ).toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 0 },
    });
  });

  it("returns auth when the token exchange fails, without calling Play", async () => {
    const calls = installFetch(
      () => new Response("token-error-body", { status: 401 }),
    );
    const result = await (await playSource(null)).listRecent(
      app,
      createBudget(0),
    );
    expect(result).toEqual({ ok: false, failure: { kind: "auth" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://oauth2.googleapis.com/token");
  });

  it("returns budget without calling Google when the budget is spent", async () => {
    const calls = installFetch(() => tokenResponse());
    const result = await (await playSource(null)).listRecent(
      app,
      createBudget(0, 0),
    );
    expect(result).toEqual({ ok: false, failure: { kind: "budget" } });
    expect(calls).toHaveLength(0);
  });

  it("reports truncation after five pages", async () => {
    const calls = installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      return Response.json({
        reviews: [
          {
            reviewId: "review-page",
            comments: [
              {
                userComment: {
                  text: "Page",
                  lastModified: { seconds: "20" },
                  starRating: 1,
                },
              },
            ],
          },
        ],
        tokenPagination: { nextPageToken: "more" },
      });
    });
    const result = await (await playSource(null)).listRecent(
      app,
      createBudget(0),
    );
    expect(calls.filter((call) => call.url.includes("/reviews"))).toHaveLength(
      5,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.reviews).toHaveLength(5);
  });
});

describe("reply", () => {
  it("posts replyText with the access token", async () => {
    const calls = installFetch((request) => {
      if (isToken(request)) return tokenResponse();
      return Response.json({});
    });
    const { lines, restore } = captureLog();
    try {
      const result = await (await playSource(null)).reply(
        app,
        "review/1",
        "Thanks",
        createBudget(0),
      );
      expect(result).toEqual({ ok: true });
      const posted = calls.find((call) => call.url.includes(":reply"));
      expect(posted?.method).toBe("POST");
      expect(posted?.url).toContain(`/applications/${APP_ID}/reviews/`);
      expect(posted?.url).toContain("review%2F1:reply");
      expect(posted?.headers.get("authorization")).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(await posted?.text()).toBe('{"replyText":"Thanks"}');
      expect(events(lines)).toEqual([{ event: "token_refreshed" }]);
      expect(lines.join("\n")).not.toContain("Thanks");
    } finally {
      restore();
    }
  });

  it("returns auth when the token exchange fails", async () => {
    const calls = installFetch(() => new Response("nope", { status: 401 }));
    const result = await (await playSource(null)).reply(
      app,
      "review-1",
      "Thanks",
      createBudget(0),
    );
    expect(result).toEqual({ ok: false, failure: { kind: "auth" } });
    expect(calls).toHaveLength(1);
  });
});

async function playSource(
  translationLanguage: string | null,
): Promise<ReviewSource> {
  return createPlaySource({
    google: { clientEmail: EMAIL, privateKeyPem: await testPem() },
    translationLanguage,
  });
}

function testPem(): Promise<string> {
  pemPromise ??= generatePem();
  return pemPromise;
}

function isToken(request: Request): boolean {
  return new URL(request.url).origin === "https://oauth2.googleapis.com";
}

function tokenResponse(): Response {
  return Response.json({
    access_token: ACCESS_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
  });
}

function events(lines: string[]): unknown[] {
  return lines.map((line) => JSON.parse(line) as unknown);
}

function installFetch(
  handler: (request: Request) => Response | Promise<Response>,
): Request[] {
  restoreFetch?.();
  const calls: Request[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    return handler(request);
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  return calls;
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
