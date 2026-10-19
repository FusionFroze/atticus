import {
  createExecutionContext,
  createScheduledController,
  env as testEnv,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { EXTERNAL_CALL_LIMIT } from "../src/lib/budget";
import { clearTokenCache } from "../src/sources/play/auth";
import {
  CHANNEL,
  emptyDatabase,
  expectQuiet,
  GUILD,
  isDiscord,
  isToken,
  labels,
  playReview,
  testPem,
  texts,
  tokenResponse,
  withCron,
} from "./cron-drive";
import { countingD1 } from "./d1-count";

const LUNE = "com.fusionfroze.Lune";
const SECOND = "com.example.second";

// Monday 2026-10-19 08:00 UTC. Each run is 15 minutes after the last, like the cron.
const T0_MS = Date.UTC(2026, 9, 19, 8, 0, 0);
const T0 = T0_MS / 1000;
const RUN_MS = 15 * 60 * 1000;

const LUNE_COUNT = 200;
const SECOND_COUNT = 5;
// The second app's reviews are older, so its backfill is posted before Lune's backlog.
const SECOND_BASE = T0 - 5 * 86_400;
const LUNE_BASE = T0 - 3 * 86_400;
// Both are among the 39 Lune reviews posted on the first run.
const EDITED = 5;
const REPLIED = 10;
const EDITED_AT = T0 - 3_600;
const REPLY_AT = T0 - 1_800;
const REPLY_TEXT = "console-reply-text";

type Call = {
  service: "token" | "play" | "discord";
  method: string;
  url: string;
  body: Record<string, unknown>;
};

type Scene = { secondStatus: number; edited: boolean; replied: boolean };

type RunResult = {
  calls: Call[];
  d1: { requests: number; statements: number };
};

beforeEach(async () => {
  await emptyDatabase();
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("integration", () => {
  it("runs the cron end to end within 45 calls per run, posting nothing twice", async () => {
    const pem = await testPem();
    const d1 = countingD1(testEnv.DB);
    const scene: Scene = { secondStatus: 403, edited: false, replied: false };
    const stored = new Map<string, Record<string, unknown>>();
    let calls: Call[] = [];
    let created = 0;
    let runIndex = 0;

    const run = async (vars: Record<string, string> = {}) => {
      runIndex += 1;
      vi.setSystemTime(T0_MS + (runIndex - 1) * RUN_MS);
      clearTokenCache();
      d1.reset();
      calls = [];
      const env = {
        APPS: [
          { store: "play", id: LUNE, name: "Lune" },
          { store: "play", id: SECOND, name: "Second" },
        ],
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: "atticus@example.iam.gserviceaccount.com",
          private_key: pem,
        }),
        DISCORD_BOT_TOKEN: "bot-token",
        DISCORD_APPLICATION_ID: "123456789012345678",
        DISCORD_PUBLIC_KEY: "ab".repeat(32),
        DISCORD_CHANNEL_ID: CHANNEL,
        ALLOWED_USER_IDS: "323456789012345678",
        TIMEZONE: "UTC",
        DIGEST_ENABLED: "false",
        ...vars,
        DB: d1.db,
      };
      await worker.scheduled(
        createScheduledController(),
        env as unknown as Env,
        createExecutionContext(),
      );
      return { calls, d1: d1.counts() } satisfies RunResult;
    };

    const handler = async (request: Request): Promise<Response> => {
      if (isToken(request)) {
        calls.push(await record("token", request));
        return tokenResponse();
      }
      if (isDiscord(request)) {
        const call = await record("discord", request);
        calls.push(call);
        return discord(call, stored, () => {
          created += 1;
          return `m-${created}`;
        });
      }
      calls.push(await record("play", request));
      return play(request, scene);
    };

    const runs: RunResult[] = [];
    const { lines } = await withCron(handler, async () => {
      // Run 1: Lune's first run backfills 200 reviews. The second app is forbidden.
      const first = await run();
      runs.push(first);
      expect(googleOrder(first)).toEqual([
        "token",
        "play lune 1",
        "play lune 2",
        "play second 1",
      ]);
      const firstPosts = discordCalls(first);
      expect(firstPosts).toHaveLength(EXTERNAL_CALL_LIMIT - 4);
      expect(firstPosts.every((call) => call.method === "POST")).toBe(true);
      expect(firstText(firstPosts[0])).toBe(
        "⚠️ Atticus doesn't have permission to read reviews for **Second**. New permissions can take up to a day to apply. README → Troubleshooting → Permission denied.",
      );
      expect(firstText(firstPosts[1])).toBe(
        "Connected to **Lune** ✓ Found 200 written reviews from the last 7 days. Posting them below, oldest first.",
      );
      expect(firstPosts.slice(2).map(bodyMark)).toEqual(
        Array.from({ length: 39 }, (_, index) => `lune-body-${index}`),
      );

      // Run 2: the second app recovers and backfills. On Lune, one posted review is
      // edited and another gets a Play Console reply.
      scene.secondStatus = 200;
      scene.edited = true;
      scene.replied = true;
      const second = await run();
      runs.push(second);
      expect(googleOrder(second)).toEqual([
        "token",
        "play lune 1",
        "play lune 2",
        "play second 1",
      ]);
      const secondCalls = discordCalls(second);
      expect(secondCalls).toHaveLength(EXTERNAL_CALL_LIMIT - 4);
      expect(firstText(secondCalls[0])).toBe(
        "✓ Back to normal: reading reviews for **Second** is working again.",
      );
      expect(firstText(secondCalls[1])).toBe(
        "Connected to **Second** ✓ Found 5 written reviews from the last 7 days. Posting them below, oldest first.",
      );
      expect(secondCalls.slice(2, 7).map(bodyMark)).toEqual(
        Array.from(
          { length: SECOND_COUNT },
          (_, index) => `second-body-${index}`,
        ),
      );
      const update = secondCalls[7];
      expect(update?.method).toBe("PATCH");
      expect(texts(update?.body ?? {})).toEqual(
        expect.arrayContaining([
          `**Your reply**\n${REPLY_TEXT}`,
          `Replied in Play Console · <t:${REPLY_AT}:R>`,
        ]),
      );
      expect(labels(update?.body ?? {})).toEqual(["Edit reply"]);
      expect(secondCalls.slice(8).map(bodyMark)).toEqual(
        Array.from({ length: 33 }, (_, index) => `lune-body-${39 + index}`),
      );

      // Runs 3 to 6 drain the backlog, oldest first. The edit is newest, so it is last.
      for (let drain = 0; drain < 4; drain++) runs.push(await run());
      const last = discordCalls(runs[5] as RunResult);
      expect(last.map((call) => call.method)).toEqual([
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "POST",
        "GET",
        "PATCH",
      ]);
      expect(last.slice(0, 5).map(bodyMark)).toEqual(
        Array.from({ length: 5 }, (_, index) => `lune-body-${195 + index}`),
      );
      const edit = last[5];
      expect(bodyMark(edit)).toBe(`lune-body-${EDITED}-edited`);
      expect(texts(edit?.body ?? {})).toEqual(
        expect.arrayContaining(["Review updated", "★2 → ★4"]),
      );
      const previous = messageFor(firstPosts, `lune-body-${EDITED}`);
      expect(edit?.body.message_reference).toEqual({
        message_id: previous,
        fail_if_not_exists: false,
      });
      expect(last[6]?.url).toBe(
        `https://discord.com/api/v10/channels/${CHANNEL}/messages/${previous}`,
      );
      expect(last[7]?.url).toBe(last[6]?.url);
      expect(labels(last[7]?.body ?? {})).toEqual([]);
      expect(JSON.stringify(last[7]?.body)).toContain(
        `Updated, see the [newer message](https://discord.com/channels/${GUILD}/${CHANNEL}/`,
      );

      // Run 7: the digest is due (Monday 09:00 UTC, 30 minutes ago). One per app.
      const digestVars = {
        DIGEST_ENABLED: "true",
        DIGEST_DAY: "mon",
        DIGEST_HOUR: "9",
      };
      const digest = await run(digestVars);
      runs.push(digest);
      const digests = discordCalls(digest);
      expect(digests.map((call) => call.method)).toEqual(["POST", "POST"]);
      expect(texts(digests[0]?.body ?? {})[0]).toBe(
        "Weekly reviews · **Lune**",
      );
      expect(texts(digests[0]?.body ?? {})[1]).toContain(
        "**200** new · **0** edited",
      );
      expect(texts(digests[1]?.body ?? {})[0]).toBe(
        "Weekly reviews · **Second**",
      );
      expect(texts(digests[1]?.body ?? {})[1]).toContain(
        "**5** new · **0** edited",
      );

      // Run 8: nothing changed, so Google only, and no second digest.
      const quiet = await run(digestVars);
      runs.push(quiet);
      expect(discordCalls(quiet)).toEqual([]);
      expect(googleOrder(quiet)).toHaveLength(4);
    });

    // Every run stays inside the budget, and the Google calls come first.
    for (const result of runs) {
      expect(result.calls.length).toBeLessThanOrEqual(EXTERNAL_CALL_LIMIT);
      const firstDiscord = result.calls.findIndex(
        (call) => call.service === "discord",
      );
      if (firstDiscord !== -1) {
        expect(
          result.calls
            .slice(firstDiscord)
            .every((c) => c.service === "discord"),
        ).toBe(true);
      }
    }

    const all = runs.flatMap(discordCalls);
    const posts = all.filter((call) => call.method === "POST");
    const patches = all.filter((call) => call.method === "PATCH");
    // 205 reviews, 1 edit, 2 Connected, 1 warning, 1 recovery and 2 digests.
    expect(posts).toHaveLength(212);
    expect(patches).toHaveLength(2);
    for (const call of [...posts, ...patches]) {
      expect(call.body.allowed_mentions).toEqual({ parse: [] });
    }
    for (const call of posts) {
      expect(call.body.enforce_nonce).toBe(true);
      expect(call.url).toBe(
        `https://discord.com/api/v10/channels/${CHANNEL}/messages`,
      );
    }

    // Nonces are the outbox ids of the rows that create a message, each once.
    const outbox = await testEnv.DB.prepare(
      "SELECT id, kind, status FROM outbox ORDER BY id",
    ).all<{ id: number; kind: string; status: string }>();
    expect(outbox.results).toHaveLength(213);
    expect(outbox.results.every((row) => row.status === "sent")).toBe(true);
    expect(posts.map((call) => call.body.nonce).sort()).toEqual(
      outbox.results
        .filter((row) => row.kind !== "message_update")
        .map((row) => `o${row.id}`)
        .sort(),
    );

    // One latest message per review. The edited review has two Discord messages.
    const latest = await testEnv.DB.prepare(
      `SELECT r.review_id AS reviewId,
              SUM(m.is_latest) AS latest,
              COUNT(DISTINCT m.message_id) AS messages
       FROM reviews r JOIN messages m ON m.review_pk = r.id
       GROUP BY r.id`,
    ).all<{ reviewId: string; latest: number; messages: number }>();
    expect(latest.results).toHaveLength(LUNE_COUNT + SECOND_COUNT);
    expect(latest.results.every((row) => row.latest === 1)).toBe(true);
    expect(
      latest.results
        .filter((row) => row.messages !== 1)
        .map((row) => [row.reviewId, row.messages]),
    ).toEqual([[`lune-${EDITED}`, 2]]);

    const edited = await testEnv.DB.prepare(
      "SELECT rating, previous_rating FROM reviews WHERE review_id = ?",
    )
      .bind(`lune-${EDITED}`)
      .first();
    expect(edited).toEqual({ rating: 4, previous_rating: 2 });
    const replied = await testEnv.DB.prepare(
      "SELECT replied_via, replied_by FROM reviews WHERE review_id = ?",
    )
      .bind(`lune-${REPLIED}`)
      .first();
    expect(replied).toEqual({ replied_via: "external", replied_by: null });

    const state = await testEnv.DB.prepare(
      "SELECT key, value FROM state ORDER BY key",
    ).all<{ key: string; value: string }>();
    const keys = state.results.map((row) => row.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        `app_seen:play:${LUNE}`,
        `app_seen:play:${SECOND}`,
        "digest_last",
        "discord_guild",
        "last_poll_at",
      ]),
    );
    expect(keys.filter((key) => key.startsWith("warn:"))).toEqual([]);
    expect(keys).not.toContain("lease");
    expect(state.results.find((row) => row.key === "digest_last")?.value).toBe(
      "2026-10-19",
    );

    const events = lines.map((line) => JSON.parse(line) as { event: string });
    const named = (event: string) =>
      events.filter((item) => item.event === event).length;
    expect(named("warning_raised")).toBe(1);
    expect(named("warning_cleared")).toBe(1);
    expect(named("review_edited")).toBe(1);
    expect(named("reply_external")).toBe(1);
    expect(named("digest_enqueued")).toBe(2);
    expect(named("budget_exhausted")).toBeGreaterThanOrEqual(1);
    expect(named("outbox_failed")).toBe(0);
    expectQuiet(lines, [
      "lune-body-",
      "second-body-",
      "Fixture Author",
      REPLY_TEXT,
      pem.split("\n")[1] ?? "",
    ]);

    // Reported for the chunk log: D1 round trips per run.
    console.log(
      `d1 per run: ${runs
        .map((result, index) => {
          const external = result.calls.length;
          return `run ${index + 1} ${result.d1.requests} requests / ${result.d1.statements} statements / ${external} external`;
        })
        .join("; ")}`,
    );
  }, 120_000);
});

async function record(
  service: Call["service"],
  request: Request,
): Promise<Call> {
  let body: Record<string, unknown> = {};
  if (service === "discord") {
    const text = await request.clone().text();
    if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
  }
  return { service, method: request.method, url: request.url, body };
}

function play(request: Request, scene: Scene): Response {
  const url = new URL(request.url);
  if (url.pathname.includes(`/applications/${SECOND}/`)) {
    if (scene.secondStatus !== 200) {
      return new Response(null, { status: scene.secondStatus });
    }
    return Response.json({ reviews: secondReviews() });
  }
  if (url.pathname.includes(`/applications/${LUNE}/`)) {
    const reviews = luneReviews(scene);
    if (url.searchParams.get("token") === "lune-page-2") {
      return Response.json({ reviews: reviews.slice(100) });
    }
    return Response.json({
      reviews: reviews.slice(0, 100),
      tokenPagination: { nextPageToken: "lune-page-2" },
    });
  }
  return new Response("unexpected", { status: 500 });
}

function luneReviews(scene: Scene): unknown[] {
  return Array.from({ length: LUNE_COUNT }, (_, index) => {
    if (index === EDITED && scene.edited) {
      return playReview({
        reviewId: `lune-${index}`,
        text: `lune-body-${index}-edited`,
        rating: 4,
        seconds: String(EDITED_AT),
      });
    }
    const base = {
      reviewId: `lune-${index}`,
      text: `lune-body-${index}`,
      rating: index === EDITED ? 2 : (index % 5) + 1,
      seconds: String(LUNE_BASE + index * 60),
    };
    if (index === REPLIED && scene.replied) {
      return playReview({
        ...base,
        reply: { text: REPLY_TEXT, seconds: String(REPLY_AT) },
      });
    }
    return playReview(base);
  });
}

function secondReviews(): unknown[] {
  return Array.from({ length: SECOND_COUNT }, (_, index) =>
    playReview({
      reviewId: `second-${index}`,
      text: `second-body-${index}`,
      rating: 5,
      seconds: String(SECOND_BASE + index * 60),
    }),
  );
}

// Creates return a new id with the guild. A GET returns what was posted there.
function discord(
  call: Call,
  stored: Map<string, Record<string, unknown>>,
  nextId: () => string,
): Response {
  const messageId = /\/messages\/([^/]+)$/.exec(call.url)?.[1];
  if (call.method === "POST") {
    const id = nextId();
    stored.set(id, call.body);
    return Response.json({ id, channel_id: CHANNEL, guild_id: GUILD });
  }
  if (messageId === undefined) {
    return new Response("unexpected", { status: 500 });
  }
  if (call.method === "GET") {
    const body = stored.get(messageId);
    if (body === undefined) return new Response(null, { status: 404 });
    return Response.json({ id: messageId, components: body.components });
  }
  stored.set(messageId, call.body);
  return Response.json({ id: messageId, channel_id: CHANNEL });
}

function googleOrder(result: RunResult): string[] {
  return result.calls
    .filter((call) => call.service !== "discord")
    .map((call) => {
      if (call.service === "token") return "token";
      const url = new URL(call.url);
      const app = url.pathname.includes(`/${LUNE}/`) ? "lune" : "second";
      const page = url.searchParams.has("token") ? 2 : 1;
      return `play ${app} ${page}`;
    });
}

function discordCalls(result: RunResult): Call[] {
  return result.calls.filter((call) => call.service === "discord");
}

function firstText(call: Call | undefined): string | undefined {
  return texts(call?.body ?? {})[0];
}

function bodyMark(call: Call | undefined): string | undefined {
  return texts(call?.body ?? {}).find((text) =>
    /^(lune|second)-body-\d+(-edited)?$/.test(text),
  );
}

// The message id Discord gave the create whose body carried this text.
function messageFor(posts: Call[], mark: string): string {
  const index = posts.findIndex((call) => bodyMark(call) === mark);
  if (index === -1) throw new Error("no post with that text");
  return `m-${index + 1}`;
}
