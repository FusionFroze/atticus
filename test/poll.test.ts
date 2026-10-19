import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { poll } from "../src/jobs/poll";
import { createBudget } from "../src/lib/budget";
import { clearTokenCache } from "../src/sources/play/auth";
import { createPlaySource } from "../src/sources/play/source";
import {
  appSeenKey,
  claimPending,
  getState,
  readReviews,
  setState,
  takeLease,
} from "../src/store";
import malformed from "./fixtures/play/malformed.json";

const NOW_MS = 1_800_000_000_000;
const NOW = 1_800_000_000;
const APP_ID = "com.fusionfroze.Lune";
const EMAIL = "atticus-poll@example.iam.gserviceaccount.com";
const ACCESS_TOKEN = "ya29.POLL_TEST_TOKEN";

const lune: AppConfig = {
  store: "play",
  id: APP_ID,
  name: "Lune",
  consoleUrl: null,
};

const broken: AppConfig = {
  store: "play",
  id: "com.example.broken",
  name: "Broken",
  consoleUrl: null,
};

let pemPromise: Promise<string> | null = null;

beforeEach(async () => {
  clearTokenCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM state"),
  ]);
});

describe("poll", () => {
  it("stores a post first run oldest first, after the connected row", async () => {
    const skipped = malformed.reviews[0];
    if (skipped === undefined) throw new Error("fixture missing");
    const { lines } = await withGoogle(
      pageOf(() => [
        playReview({
          reviewId: "review-newer",
          text: "Newer body",
          rating: 3,
          seconds: "1700000500",
        }),
        skipped,
        playReview({
          reviewId: "review-older",
          text: "Older body",
          rating: 5,
          seconds: "1700000000",
        }),
      ]),
      () => pollOnce("post"),
    );

    const older = await one("review-older");
    const newer = await one("review-newer");
    expect(older).toMatchObject({
      rating: 5,
      body: "Older body",
      previousRating: null,
      firstSeenAt: NOW,
      repliedVia: null,
    });
    expect(await queued()).toEqual([
      expect.objectContaining({
        kind: "connected",
        reviewPk: null,
        sortKey: 0,
        payload: connectedPayload(lune, 2, "post"),
      }),
      expect.objectContaining({
        kind: "review_new",
        reviewPk: older.id,
        sortKey: 1_700_000_000,
        payload: "{}",
      }),
      expect.objectContaining({
        kind: "review_new",
        reviewPk: newer.id,
        sortKey: 1_700_000_500,
        payload: "{}",
      }),
    ]);
    expect(await count("reviews")).toBe(2);
    expect(await getState(env.DB, appSeenKey(lune))).toBe("1");
    expect(await getState(env.DB, "last_poll_at")).toBe(String(NOW));
    expect(await getState(env.DB, "lease")).toBeNull();
    expect(events(lines)).toContainEqual({
      event: "review_malformed",
      appId: APP_ID,
      reviewId: "review-rating-0",
      reason: "rating",
    });
    expect(events(lines).filter((event) => event.event === "poll_app")).toEqual(
      [
        {
          event: "poll_app",
          appId: APP_ID,
          count: 2,
          reviewIds: ["review-newer", "review-older"],
        },
      ],
    );
    expectClean(lines, ["Newer body", "Older body", "Zero stars."]);
  });

  it("stores a silent first run without review_new rows", async () => {
    const { lines } = await withGoogle(
      pageOf(() => twoReviews()),
      () => pollOnce("silent"),
    );

    expect(await one("review-older")).toMatchObject({ body: "Older body" });
    expect(await one("review-newer")).toMatchObject({ body: "Newer body" });
    expect(await queued()).toEqual([
      expect.objectContaining({
        kind: "connected",
        sortKey: 0,
        payload: connectedPayload(lune, 2, "silent"),
      }),
    ]);
    expect(await getState(env.DB, appSeenKey(lune))).toBe("1");
    expectClean(lines, ["Newer body", "Older body"]);
  });

  it("adds no outbox rows when the same reviews are polled again", async () => {
    await withGoogle(
      pageOf(() => [
        playReview({
          reviewId: "review-1",
          text: "Same body",
          rating: 4,
          seconds: "1700000000",
        }),
      ]),
      async () => {
        await pollOnce("post");
        const first = await queued();
        await pollOnce("post");
        expect(await queued()).toEqual(first);
        expect(await count("reviews")).toBe(1);
      },
    );
  });

  it("enqueues review_edited and keeps the previous rating", async () => {
    let reviews = [
      playReview({
        reviewId: "review-1",
        text: "Stored body",
        rating: 4,
        seconds: "1700000000",
      }),
    ];
    const { lines } = await withGoogle(
      pageOf(() => reviews),
      async () => {
        await pollOnce("silent");
        reviews = [
          playReview({
            reviewId: "review-1",
            text: "Edited body",
            rating: 2,
            seconds: "1700000100",
          }),
        ];
        await pollOnce("silent");
      },
    );

    const row = await one("review-1");
    expect(row).toMatchObject({
      rating: 2,
      previousRating: 4,
      body: "Edited body",
      modifiedAt: 1_700_000_100,
    });
    expect(await queued()).toEqual([
      expect.objectContaining({ kind: "connected", sortKey: 0 }),
      expect.objectContaining({
        kind: "review_edited",
        reviewPk: row.id,
        sortKey: 1_700_000_100,
        payload: "{}",
      }),
    ]);
    expectClean(lines, ["Stored body", "Edited body"]);
  });

  it("keeps one pending review_new when an edit arrives before it is sent", async () => {
    let reviews = [
      playReview({
        reviewId: "review-1",
        text: "Stored body",
        rating: 4,
        seconds: "1700000000",
      }),
    ];
    await withGoogle(
      pageOf(() => reviews),
      async () => {
        await pollOnce("post");
        reviews = [
          playReview({
            reviewId: "review-1",
            text: "Edited body",
            rating: 1,
            seconds: "1700000100",
          }),
        ];
        await pollOnce("post");
      },
    );

    const row = await one("review-1");
    expect(row).toMatchObject({
      body: "Edited body",
      rating: 1,
      previousRating: 4,
      modifiedAt: 1_700_000_100,
    });
    expect(await queued()).toEqual([
      expect.objectContaining({ kind: "connected", sortKey: 0 }),
      expect.objectContaining({
        kind: "review_new",
        reviewPk: row.id,
        sortKey: 1_700_000_000,
        payload: "{}",
        status: "pending",
      }),
    ]);
  });

  it("enqueues message_update when a reply appears", async () => {
    let reviews = [
      playReview({
        reviewId: "review-1",
        text: "Stored body",
        rating: 5,
        seconds: "1700000000",
      }),
    ];
    const { lines } = await withGoogle(
      pageOf(() => reviews),
      async () => {
        await pollOnce("silent");
        reviews = [
          playReview({
            reviewId: "review-1",
            text: "Stored body",
            rating: 5,
            seconds: "1700000000",
            reply: { text: "From console", seconds: "40" },
          }),
        ];
        await pollOnce("silent");
      },
    );

    const row = await one("review-1");
    expect(row).toMatchObject({
      replyText: "From console",
      replyModifiedAt: 40,
      repliedVia: "external",
      repliedBy: null,
      repliedAt: null,
    });
    expect(await queued()).toEqual([
      expect.objectContaining({ kind: "connected", sortKey: 0 }),
      expect.objectContaining({
        kind: "message_update",
        reviewPk: row.id,
        sortKey: 1_700_000_000,
        payload: "{}",
      }),
    ]);
    expectClean(lines, ["Stored body", "From console"]);
  });

  it("adds no outbox row when the stored bot reply text matches", async () => {
    let reviews = [
      playReview({
        reviewId: "review-1",
        text: "Stored body",
        rating: 5,
        seconds: "1700000000",
      }),
    ];
    await withGoogle(
      pageOf(() => reviews),
      async () => {
        await pollOnce("silent");
        await env.DB.prepare(
          `UPDATE reviews
           SET reply_text = ?, reply_modified_at = 10, replied_via = 'bot',
               replied_by = 'user-1', replied_at = 60
           WHERE review_id = ?`,
        )
          .bind("Thanks", "review-1")
          .run();
        const before = await queued();
        reviews = [
          playReview({
            reviewId: "review-1",
            text: "Stored body",
            rating: 5,
            seconds: "1700000000",
            reply: { text: "Thanks", seconds: "20" },
          }),
        ];
        await pollOnce("silent");
        expect(await queued()).toEqual(before);
      },
    );

    expect(await one("review-1")).toMatchObject({
      replyText: "Thanks",
      replyModifiedAt: 20,
      repliedVia: "bot",
      repliedBy: "user-1",
      repliedAt: 60,
    });
  });

  it("clears a reply and enqueues message_update when it is removed", async () => {
    let reviews = [
      playReview({
        reviewId: "review-1",
        text: "Stored body",
        rating: 4,
        seconds: "1700000000",
        reply: { text: "Console reply", seconds: "30" },
      }),
    ];
    const { lines } = await withGoogle(
      pageOf(() => reviews),
      async () => {
        await pollOnce("silent");
        expect(await one("review-1")).toMatchObject({
          repliedVia: "external",
          replyText: "Console reply",
        });
        reviews = [
          playReview({
            reviewId: "review-1",
            text: "Stored body",
            rating: 4,
            seconds: "1700000000",
          }),
        ];
        await pollOnce("silent");
      },
    );

    const row = await one("review-1");
    expect(row).toMatchObject({
      replyText: null,
      replyModifiedAt: null,
      repliedVia: null,
      repliedBy: null,
      repliedAt: null,
    });
    expect(await queued()).toEqual([
      expect.objectContaining({ kind: "connected", sortKey: 0 }),
      expect.objectContaining({
        kind: "message_update",
        reviewPk: row.id,
        sortKey: 1_700_000_000,
        payload: "{}",
      }),
    ]);
    expectClean(lines, ["Stored body", "Console reply"]);
  });

  it("stores the other app when one Play list returns 403", async () => {
    const { lines, calls } = await withGoogle(
      (request) => {
        if (isToken(request)) return tokenResponse();
        if (request.url.includes(`/applications/${broken.id}/`)) {
          return new Response(null, { status: 403 });
        }
        if (request.url.includes(`/applications/${lune.id}/`)) {
          return Response.json({
            reviews: [
              playReview({
                reviewId: "review-lune",
                text: "Lune body",
                rating: 5,
                seconds: "1700000000",
              }),
            ],
          });
        }
        return new Response("unexpected", { status: 500 });
      },
      () => pollOnce("post", [broken, lune]),
    );

    expect(
      calls.some((url) => url.includes(`/applications/${broken.id}/`)),
    ).toBe(true);
    expect(calls.some((url) => url.includes(`/applications/${lune.id}/`))).toBe(
      true,
    );
    expect(await getState(env.DB, appSeenKey(broken))).toBeNull();
    expect(await getState(env.DB, appSeenKey(lune))).toBe("1");
    expect(await countWhere("reviews", broken.id)).toBe(0);
    const row = await one("review-lune");
    expect(await queued()).toEqual([
      expect.objectContaining({
        kind: "warning",
        sortKey: -1,
        payload: JSON.stringify({
          notice: "warning",
          warning: "play_forbidden",
          appId: broken.id,
        }),
      }),
      expect.objectContaining({
        kind: "connected",
        sortKey: 0,
        payload: connectedPayload(lune, 1, "post"),
      }),
      expect.objectContaining({
        kind: "review_new",
        reviewPk: row.id,
        sortKey: 1_700_000_000,
      }),
    ]);
    expect(await getState(env.DB, `warn:play_forbidden:${broken.id}`)).toBe(
      "Broken",
    );
    expect(events(lines)).toContainEqual({
      event: "warning_raised",
      kind: "play_forbidden",
      appId: broken.id,
    });
    expect(events(lines)).toContainEqual({
      event: "poll_failed",
      appId: broken.id,
      kind: "forbidden",
    });
    expectClean(lines, ["Lune body"]);
  });

  it("carries on after a Play 429 and does not warn", async () => {
    const { lines, calls } = await withGoogle(
      (request) => {
        if (isToken(request)) return tokenResponse();
        if (request.url.includes(`/applications/${broken.id}/`)) {
          return new Response(null, { status: 429 });
        }
        if (request.url.includes(`/applications/${lune.id}/`)) {
          return Response.json({
            reviews: [
              playReview({
                reviewId: "review-lune",
                text: "Lune body",
                rating: 5,
                seconds: "1700000000",
              }),
            ],
          });
        }
        return new Response("unexpected", { status: 500 });
      },
      () => pollOnce("post", [broken, lune]),
    );

    expect(calls.some((url) => url.includes(`/applications/${lune.id}/`))).toBe(
      true,
    );
    expect(await getState(env.DB, appSeenKey(lune))).toBe("1");
    expect(await countWhere("reviews", broken.id)).toBe(0);
    expect(await queued()).toEqual([
      expect.objectContaining({ kind: "connected", sortKey: 0 }),
      expect.objectContaining({ kind: "review_new" }),
    ]);
    expect(events(lines)).toContainEqual({
      event: "poll_failed",
      appId: broken.id,
      kind: "rate_limited",
    });
    expect(
      events(lines).some((event) => event.event === "warning_raised"),
    ).toBe(false);
    expectClean(lines, ["Lune body"]);
  });

  it("clears a play warning whose app left the config", async () => {
    await setState(
      env.DB,
      "warn:play_forbidden:com.fusionfroze.atticus.missing",
      "Missing",
      NOW,
    );
    const { lines } = await withGoogle(
      pageOf(() => []),
      () => pollOnce("post"),
    );
    expect(
      await getState(
        env.DB,
        "warn:play_forbidden:com.fusionfroze.atticus.missing",
      ),
    ).toBeNull();
    expect(await queued()).toContainEqual(
      expect.objectContaining({
        kind: "recovered",
        sortKey: -1,
        payload: JSON.stringify({
          notice: "recovered",
          subject: "play_forbidden",
          appName: "Missing",
        }),
      }),
    );
    expect(events(lines)).toContainEqual({
      event: "warning_cleared",
      kind: "play_forbidden",
      appId: "com.fusionfroze.atticus.missing",
    });
  });

  it("logs run_skipped_locked and skips Google when the lease is held", async () => {
    expect(await takeLease(env.DB, NOW, "held-before")).toBe(true);
    const { lines, calls } = await withGoogle(
      pageOf(() => twoReviews()),
      () => pollOnce("post"),
    );

    expect(calls).toEqual([]);
    expect(events(lines)).toEqual([{ event: "run_skipped_locked" }]);
    expect(await count("reviews")).toBe(0);
    expect(await count("outbox")).toBe(0);
    expect(await count("messages")).toBe(0);
    expect(await getState(env.DB, "last_poll_at")).toBeNull();
    expect(await getState(env.DB, appSeenKey(lune))).toBeNull();
    const keys = await env.DB.prepare(
      "SELECT key FROM state ORDER BY key",
    ).all<{ key: string }>();
    expect(keys.results.map((row) => row.key)).toEqual(["lease"]);
  });
});

async function pollOnce(
  backfill: "post" | "silent",
  apps: AppConfig[] = [lune],
): Promise<void> {
  const google = { clientEmail: EMAIL, privateKeyPem: await testPem() };
  await poll({
    db: env.DB,
    config: {
      apps,
      google,
      discord: {
        botToken: "bot-token",
        applicationId: "123456789012345678",
        publicKey: "ab".repeat(32),
        channelId: "223456789012345678",
      },
      allowedUserIds: new Set(["323456789012345678"]),
      translationLanguage: null,
      backfill,
      pingOnLowRating: null,
      timezone: "UTC",
      digest: { enabled: false, day: 1, hour: 9 },
      dryRun: true,
    },
    source: createPlaySource({ google, translationLanguage: null }),
    budget: createBudget(NOW_MS),
    nowMs: NOW_MS,
  });
}

function twoReviews(): ReturnType<typeof playReview>[] {
  return [
    playReview({
      reviewId: "review-newer",
      text: "Newer body",
      rating: 3,
      seconds: "1700000500",
    }),
    playReview({
      reviewId: "review-older",
      text: "Older body",
      rating: 5,
      seconds: "1700000000",
    }),
  ];
}

function playReview(input: {
  reviewId: string;
  text: string;
  rating: 1 | 2 | 3 | 4 | 5;
  seconds: string;
  reply?: { text: string; seconds: string };
}): { reviewId: string; comments: unknown[] } {
  const comments: unknown[] = [
    {
      userComment: {
        text: input.text,
        starRating: input.rating,
        lastModified: { seconds: input.seconds },
      },
    },
  ];
  if (input.reply !== undefined) {
    comments.push({
      developerComment: {
        text: input.reply.text,
        lastModified: { seconds: input.reply.seconds },
      },
    });
  }
  return { reviewId: input.reviewId, comments };
}

function pageOf(reviews: () => unknown): (request: Request) => Response {
  return (request) => {
    if (isToken(request)) return tokenResponse();
    return Response.json({ reviews: reviews() });
  };
}

function connectedPayload(
  app: AppConfig,
  count: number,
  backfill: "post" | "silent",
): string {
  return JSON.stringify({
    store: app.store,
    appId: app.id,
    appName: app.name,
    count,
    backfill,
  });
}

async function withGoogle(
  handler: (request: Request) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<{ lines: string[]; calls: string[] }> {
  const lines: string[] = [];
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  console.log = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.log;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request.url);
    return handler(request);
  }) as typeof fetch;
  try {
    await run();
    return { lines, calls };
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
}

function expectClean(lines: string[], extra: string[]): void {
  const text = lines.join("\n");
  for (const secret of [ACCESS_TOKEN, "BEGIN PRIVATE KEY", ...extra]) {
    expect(text).not.toContain(secret);
  }
}

function events(lines: string[]): Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function queued() {
  return claimPending(env.DB, NOW, 20);
}

async function one(reviewId: string, appId = APP_ID) {
  const found = await readReviews(env.DB, "play", appId, [reviewId]);
  const row = found.get(reviewId);
  if (row === undefined) throw new Error(`missing ${reviewId}`);
  return row;
}

async function count(
  table: "reviews" | "outbox" | "messages",
): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

async function countWhere(table: "reviews", appId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE app_id = ?`,
  )
    .bind(appId)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
