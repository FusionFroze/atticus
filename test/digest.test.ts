import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/types";
import { WEEK_SECONDS } from "../src/core/digest";
import type { Review } from "../src/core/review";
import { DISCORD_API } from "../src/notifiers/discord/client";
import {
  appSeenKey,
  DIGEST_LAST_KEY,
  DISCORD_GUILD_KEY,
  getState,
  insertReviewWithOutbox,
  setState,
} from "../src/store";
import {
  CHANNEL,
  emptyDatabase,
  expectQuiet,
  GUILD,
  isDiscord,
  isToken,
  lune,
  playList,
  pollAt,
  sendOutbox,
  tokenResponse,
  withCron,
} from "./cron-drive";

const MONDAY = Date.parse("2026-10-19T09:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const BODY = "fixture-digest-body";
const TITLE = "@everyone";
const MESSAGE = "111111111111111111";

const due = { enabled: true, day: 1 as const, hour: 9 };

const other: AppConfig = {
  store: "play",
  id: "com.example.other",
  name: "Other",
  consoleUrl: null,
};

type Call = { method: string; url: string; body: Record<string, unknown> };

beforeEach(async () => {
  await emptyDatabase();
});

describe("weekly digest", () => {
  it("enqueues one digest per app and does not enqueue again that week", async () => {
    await seen([lune, other]);
    const first = await drive(() =>
      pollAt({
        apps: [lune, other],
        nowMs: MONDAY,
        timezone: "UTC",
        digest: due,
      }),
    );
    const rows = await digestRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
      { appId: lune.id, windowEnd: Math.floor(MONDAY / 1000) },
      { appId: other.id, windowEnd: Math.floor(MONDAY / 1000) },
    ]);
    expect(
      rows.every((row) => row.sort_key === Math.floor(MONDAY / 1000)),
    ).toBe(true);
    expect(await getState(env.DB, DIGEST_LAST_KEY)).toBe("2026-10-19");
    expect(
      named(first.lines, "digest_enqueued").map((event) => event.appId),
    ).toEqual([lune.id, other.id]);

    const second = await drive(() =>
      pollAt({
        apps: [lune, other],
        nowMs: MONDAY + 15 * 60 * 1000,
        timezone: "UTC",
        digest: due,
      }),
    );
    expect(await digestRows()).toHaveLength(2);
    expect(
      named(second.lines, "digest_enqueued").concat(
        named(second.lines, "digest_skipped"),
      ),
    ).toEqual([]);
  });

  it("skips a slot that is 24 hours late and logs it once", async () => {
    await seen([lune]);
    const first = await drive(() =>
      pollAt({
        nowMs: MONDAY + DAY_MS,
        timezone: "UTC",
        digest: due,
      }),
    );
    expect(await digestRows()).toEqual([]);
    expect(await getState(env.DB, DIGEST_LAST_KEY)).toBe("2026-10-19");
    expect(named(first.lines, "digest_skipped")).toEqual([
      { event: "digest_skipped", localDate: "2026-10-19" },
    ]);

    const second = await drive(() =>
      pollAt({
        nowMs: MONDAY + DAY_MS + 60_000,
        timezone: "UTC",
        digest: due,
      }),
    );
    expect(named(second.lines, "digest_skipped")).toEqual([]);
    expect(await digestRows()).toEqual([]);
  });

  it("does nothing when the digest is disabled", async () => {
    await seen([lune]);
    const { lines } = await drive(() =>
      pollAt({
        nowMs: MONDAY,
        timezone: "UTC",
        digest: { enabled: false, day: 1, hour: 9 },
      }),
    );
    expect(await digestRows()).toEqual([]);
    expect(await getState(env.DB, DIGEST_LAST_KEY)).toBeNull();
    expect(named(lines, "digest_enqueued")).toEqual([]);
    expect(named(lines, "digest_skipped")).toEqual([]);
  });

  it("sends the digest through the outbox once and does not log the review", async () => {
    const end = Math.floor(MONDAY / 1000);
    await seen([lune]);
    const reviewId = await save({
      reviewId: "this-week",
      rating: 2,
      title: TITLE,
      firstSeen: end - 3600,
      modifiedAt: end - 3600,
      version: null,
    });
    await env.DB.prepare(
      `INSERT INTO messages (
         review_pk, version, channel_id, message_id, is_latest, created_at
       ) VALUES (?, 1, ?, ?, 1, ?)`,
    )
      .bind(reviewId, CHANNEL, MESSAGE, end)
      .run();
    await save({
      reviewId: "last-week",
      rating: 4,
      title: null,
      firstSeen: end - WEEK_SECONDS - 10,
      modifiedAt: end - WEEK_SECONDS - 10,
      version: "1.0",
    });
    await save({
      reviewId: "edited-older",
      rating: 5,
      title: null,
      firstSeen: end - 2 * WEEK_SECONDS - 10,
      modifiedAt: end - 10,
      version: "1.0",
    });

    const { lines, calls } = await drive(async () => {
      await pollAt({ nowMs: MONDAY, timezone: "UTC", digest: due });
      await sendOutbox([lune]);
      await sendOutbox([lune]);
    });

    const queued = await digestRows();
    const posts = discord(calls).filter((call) => call.method === "POST");
    const gets = discord(calls).filter((call) => call.method === "GET");
    expect(gets.map((call) => call.url)).toEqual([
      `${DISCORD_API}/channels/${CHANNEL}`,
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body.nonce).toBe(`o${queued[0]?.id}`);
    expect(posts[0]?.body.enforce_nonce).toBe(true);
    expect(posts[0]?.body.allowed_mentions).toEqual({ parse: [] });
    const digestPost = JSON.stringify(posts[0]?.body);
    expect(digestPost).toContain("**1** new · **1** edited");
    expect(digestPost).toContain("Average **2.0** · \u22122.0 vs last week");
    expect(digestPost).toContain("★★☆☆☆  1");
    expect(digestPost).toContain("Replied **0/1** · 0%");
    expect(digestPost).toContain("Unknown · 1");
    expect(digestPost).toContain(
      `★2 · [@everyone](https://discord.com/channels/${GUILD}/${CHANNEL}/${MESSAGE})`,
    );
    expect(digestPost).not.toContain(BODY);
    expect(await getState(env.DB, DISCORD_GUILD_KEY)).toBe(GUILD);
    const stored = await env.DB.prepare(
      "SELECT status FROM outbox ORDER BY sort_key, id",
    ).all<{ status: string }>();
    expect(stored.results.every((row) => row.status === "sent")).toBe(true);
    const messages = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM messages",
    ).first<{ n: number }>();
    expect(messages?.n).toBe(1);
    expectQuiet(lines, [BODY, TITLE]);
  });

  it("fails a digest whose payload is not an app and a window", async () => {
    await env.DB.prepare(
      `INSERT INTO outbox (
         kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
       ) VALUES ('digest', NULL, '{}', 'pending', 1, 0, 0, 1)`,
    ).run();
    const { calls } = await drive(() => sendOutbox([lune]));
    expect(discord(calls)).toEqual([]);
    const row = await env.DB.prepare(
      "SELECT status, last_error FROM outbox WHERE kind = 'digest'",
    ).first<{ status: string; last_error: string | null }>();
    expect(row).toEqual({ status: "failed", last_error: "payload invalid" });
  });
});

async function seen(apps: readonly AppConfig[]): Promise<void> {
  for (const app of apps) {
    await setState(env.DB, appSeenKey(app), "1", 1);
  }
}

async function save(input: {
  reviewId: string;
  rating: Review["rating"];
  title: string | null;
  firstSeen: number;
  modifiedAt: number;
  version: string | null;
}): Promise<number> {
  return insertReviewWithOutbox(env.DB, {
    review: {
      store: "play",
      appId: lune.id,
      reviewId: input.reviewId,
      author: null,
      rating: input.rating,
      title: input.title,
      body: BODY,
      originalBody: null,
      language: null,
      appVersionName: input.version,
      appVersionCode: null,
      osVersion: null,
      device: null,
      thumbsUp: 0,
      modifiedAt: input.modifiedAt,
      developerReply: null,
    },
    nowSeconds: input.firstSeen,
    enqueue: false,
  });
}

async function digestRows(): Promise<
  { id: number; payload: string; sort_key: number }[]
> {
  const rows = await env.DB.prepare(
    "SELECT id, payload, sort_key FROM outbox WHERE kind = 'digest' ORDER BY id",
  ).all<{ id: number; payload: string; sort_key: number }>();
  return rows.results;
}

async function drive(
  run: () => Promise<void>,
): Promise<{ lines: string[]; calls: Call[] }> {
  const calls: Call[] = [];
  const { lines } = await withCron(async (request) => {
    calls.push({
      method: request.method,
      url: request.url,
      body: await jsonBody(request),
    });
    if (isToken(request)) return tokenResponse();
    if (isDiscord(request)) {
      if (request.method === "GET") {
        return Response.json({ id: CHANNEL, guild_id: GUILD, type: 0 });
      }
      return Response.json({ id: "222222222222222222", guild_id: GUILD });
    }
    return playList([]);
  }, run);
  return { lines, calls };
}

function discord(calls: readonly Call[]): Call[] {
  return calls.filter((call) => isDiscord(new Request(call.url)));
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("json")) return {};
  const text = await request.clone().text();
  if (text === "") return {};
  return JSON.parse(text) as Record<string, unknown>;
}

function named(
  lines: readonly string[],
  event: string,
): { event?: string; appId?: string; localDate?: string }[] {
  return lines
    .map(
      (line) =>
        JSON.parse(line) as {
          event?: string;
          appId?: string;
          localDate?: string;
        },
    )
    .filter((entry) => entry.event === event);
}
