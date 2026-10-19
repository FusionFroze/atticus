import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config/types";
import type { Review } from "../src/core/review";
import { send } from "../src/jobs/send";
import { type Budget, createBudget } from "../src/lib/budget";
import { isRecord } from "../src/lib/record";
import {
  createDiscordClient,
  DISCORD_API,
} from "../src/notifiers/discord/client";
import { createDiscordNotifier } from "../src/notifiers/discord/notifier";
import {
  getState,
  insertReviewWithOutbox,
  markOutboxSent,
  writeFirstRun,
} from "../src/store";

const APP = "com.fusionfroze.Lune";
const CHANNEL = "223456789012345678";
const USER = "423456789012345678";
const NOW_MS = 1_800_000_000_000;
const NOW = 1_800_000_000;
const MARKER = "UNIQUE_DISCORD_BODY_MARKER";
const MESSAGE = "888888888888888888";

const lune = {
  store: "play" as const,
  id: APP,
  name: "Lune",
  consoleUrl: null,
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM state"),
  ]);
});

describe("send", () => {
  it("posts Connected first, then reviews oldest first, with a nonce", async () => {
    await writeFirstRun(env.DB, {
      app: lune,
      reviews: [
        review({ reviewId: "newer", modifiedAt: 300, body: "fixture-newer" }),
        review({ reviewId: "older", modifiedAt: 100, body: "fixture-older" }),
      ],
      backfill: "post",
      nowSeconds: NOW,
    });
    const queued = await rows();
    const { calls, lines } = await drive(
      () => ok("1"),
      () => runSend(createBudget(Date.now())),
    );

    expect(calls.map(description)).toEqual([
      "Connected to **Lune** ✓ Found 2 written reviews from the last 7 days. Posting them below, oldest first.",
      "fixture-older",
      "fixture-newer",
    ]);
    expect(calls.map((call) => call.body.nonce)).toEqual(
      queued.map((row) => `o${row.id}`),
    );
    expect(calls.every((call) => call.method === "POST")).toBe(true);
    expect(calls.every((call) => call.body.enforce_nonce === true)).toBe(true);
    expect((await rows()).every((row) => row.status === "sent")).toBe(true);
    expectQuiet(lines, ["fixture-older", "fixture-newer"]);
  });

  it("posts the same nonce again when marking the row throws", async () => {
    await saveQueued(review({ body: "fixture-body" }));
    const budget = createBudget(Date.now());
    let thrown = false;
    const markSent: typeof markOutboxSent = async (db, input) => {
      if (!thrown) {
        thrown = true;
        throw new Error("mark failed once");
      }
      await markOutboxSent(db, input);
    };
    const { calls, lines } = await drive(
      () => ok("4"),
      async () => {
        expect(await runSend(budget, { markSent })).toBe(0);
        expect(await onlyRow()).toMatchObject({
          status: "pending",
          attempts: 0,
        });
        expect(await runSend(budget, { markSent })).toBe(1);
      },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.nonce).toBe(calls[1]?.body.nonce);
    expect(calls[0]?.body.enforce_nonce).toBe(true);
    expect(calls[1]?.body.enforce_nonce).toBe(true);
    expect(await onlyRow()).toMatchObject({ status: "sent" });
    expect(lines.join("\n")).not.toContain("mark failed once");
    expect(events(lines)).toContainEqual({
      event: "send_stopped",
      why: "store",
    });
  });

  it("stops on 429 and leaves every row pending", async () => {
    await saveQueued(review({ reviewId: "first", modifiedAt: 1 }));
    await saveQueued(review({ reviewId: "second", modifiedAt: 2 }));
    const { calls, lines } = await drive(
      () => json(429, { retry_after: 3, message: MARKER }),
      () => runSend(createBudget(Date.now())),
    );

    expect(calls).toHaveLength(1);
    expect(await rows()).toEqual([
      expect.objectContaining({
        status: "pending",
        attempts: 0,
        last_error: null,
      }),
      expect.objectContaining({
        status: "pending",
        attempts: 0,
        last_error: null,
      }),
    ]);
    expect(events(lines)).toContainEqual({
      event: "send_stopped",
      why: "rate_limited",
    });
    expect(events(lines).some((event) => event.event === "outbox_retry")).toBe(
      false,
    );
    expectQuiet(lines, [MARKER]);
  });

  it("backs off a 500 and fails the row on the fifth", async () => {
    await saveQueued(review());
    const delays = [60, 300, 900, 3600];
    let nowMs = NOW_MS;
    const { lines } = await drive(
      () => new Response(null, { status: 500 }),
      async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
          const delay = delays[attempt];
          if (delay === undefined) throw new Error("missing delay");
          expect(await runSend(createBudget(Date.now()), { nowMs })).toBe(0);
          const row = await onlyRow();
          expect(row).toMatchObject({
            status: "pending",
            attempts: attempt + 1,
            next_attempt_at: Math.floor(nowMs / 1000) + delay,
            last_error: "500 unavailable",
          });
          nowMs = row.next_attempt_at * 1000;
        }
        expect(await runSend(createBudget(Date.now()), { nowMs })).toBe(0);
      },
    );

    expect(await onlyRow()).toMatchObject({
      status: "failed",
      attempts: 4,
      last_error: "500 unavailable",
    });
    expect(
      events(lines).filter((event) => event.event === "outbox_retry"),
    ).toHaveLength(4);
    expect(
      events(lines).filter((event) => event.event === "outbox_failed"),
    ).toHaveLength(1);
  });

  it("fails a 400 and still sends the next row", async () => {
    await saveQueued(
      review({ reviewId: "bad", modifiedAt: 1, body: "fixture-bad" }),
    );
    await saveQueued(
      review({ reviewId: "good", modifiedAt: 2, body: "fixture-good" }),
    );
    const { calls, lines } = await drive(
      (index) => (index === 0 ? json(400, { message: MARKER }) : ok("2")),
      () => runSend(createBudget(Date.now())),
    );

    expect(calls).toHaveLength(2);
    expect(description(calls[1])).toBe("fixture-good");
    expect(await rows()).toEqual([
      expect.objectContaining({ status: "failed", last_error: "400 invalid" }),
      expect.objectContaining({ status: "sent" }),
    ]);
    expectQuiet(lines, [MARKER, "fixture-bad", "fixture-good"]);
  });

  it("stops when the budget is spent and when it starts empty", async () => {
    await saveQueued(review({ reviewId: "first", modifiedAt: 1 }));
    await saveQueued(review({ reviewId: "second", modifiedAt: 2 }));
    const limited = await drive(
      () => ok("1"),
      () => runSend(createBudget(Date.now(), 1)),
    );
    expect(limited.calls).toHaveLength(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ status: "sent" }),
      expect.objectContaining({ status: "pending", attempts: 0 }),
    ]);
    expect(events(limited.lines)).toContainEqual({ event: "budget_exhausted" });
    expect(events(limited.lines)).toContainEqual({
      event: "send_stopped",
      why: "budget",
    });

    await env.DB.prepare("DELETE FROM outbox").run();
    await env.DB.prepare("DELETE FROM messages").run();
    await saveQueued(review({ reviewId: "third", modifiedAt: 3 }));
    const empty = await drive(
      () => ok("1"),
      () => runSend(createBudget(Date.now(), 0)),
    );
    expect(empty.calls).toEqual([]);
    expect(events(empty.lines)).toContainEqual({
      event: "send_stopped",
      why: "budget",
    });
  });

  it("stops at the deadline before calling Discord", async () => {
    await saveQueued(review());
    const { calls, lines } = await drive(
      () => ok("1"),
      () => runSend(createBudget(Date.now() - 1_000, 45, 0)),
    );
    expect(calls).toEqual([]);
    expect(await onlyRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(events(lines)).toContainEqual({
      event: "send_stopped",
      why: "deadline",
    });
    expect(
      events(lines).some((event) => event.event === "budget_exhausted"),
    ).toBe(false);
  });

  it("drains 200 reviews and Connected over several runs", async () => {
    const reviews = Array.from({ length: 200 }, (_, index) =>
      review({
        reviewId: `r-${index}`,
        modifiedAt: 1_000 + index,
        body: `fixture-${index}`,
        author: "Should Not Log Author",
      }),
    );
    await writeFirstRun(env.DB, {
      app: lune,
      reviews,
      backfill: "post",
      nowSeconds: NOW,
    });
    const queued = await rows();
    const counts: number[] = [];
    const { calls, lines } = await drive(
      (index) => ok(String(index + 1)),
      async (sent) => {
        for (let run = 0; run < 5; run++) {
          const before = sent.length;
          const budget = createBudget(Date.now(), 45, 120_000);
          await runSend(budget);
          counts.push(sent.length - before);
        }
      },
    );

    expect(counts).toEqual([45, 45, 45, 45, 21]);
    expect(counts.every((count) => count <= 45)).toBe(true);
    expect(description(calls[0])).toBe(
      "Connected to **Lune** ✓ Found 200 written reviews from the last 7 days. Posting them below, oldest first.",
    );
    expect(description(calls[1])).toBe("fixture-0");
    expect(description(calls[200])).toBe("fixture-199");
    expect(calls.map((call) => call.body.nonce)).toEqual(
      queued.map((row) => `o${row.id}`),
    );
    expect(calls.every((call) => call.body.enforce_nonce === true)).toBe(true);
    expect((await rows()).every((row) => row.status === "sent")).toBe(true);
    expectQuiet(lines, ["fixture-0", "fixture-199", "Should Not Log Author"]);
  }, 30_000);

  it("stops on a channel error and sets the warning flag", async () => {
    await saveQueued(review({ reviewId: "first", modifiedAt: 1 }));
    await saveQueued(review({ reviewId: "second", modifiedAt: 2 }));
    const { calls, lines } = await drive(
      () => new Response(null, { status: 403 }),
      () => runSend(createBudget(Date.now())),
    );
    expect(calls).toHaveLength(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ status: "pending", attempts: 0 }),
      expect.objectContaining({ status: "pending", attempts: 0 }),
    ]);
    expect(await getState(env.DB, "warn:discord_channel")).toBe("1");
    expect(events(lines)).toContainEqual({
      event: "send_stopped",
      why: "channel",
    });
  });

  it("stops on 401 without the channel warning", async () => {
    await saveQueued(review());
    const { lines } = await drive(
      () => new Response(null, { status: 401 }),
      () => runSend(createBudget(Date.now())),
    );
    expect(await onlyRow()).toMatchObject({ status: "pending", attempts: 0 });
    expect(await getState(env.DB, "warn:discord_channel")).toBeNull();
    expect(events(lines)).toContainEqual({
      event: "send_stopped",
      why: "unauthorized",
    });
  });

  it("posts an edit and patches the latest message", async () => {
    const edited = await save(
      review({ reviewId: "edited", rating: 1, modifiedAt: 10 }),
    );
    const updated = await save(
      review({ reviewId: "updated", rating: 1, modifiedAt: 20 }),
    );
    const editedId = await enqueue({
      kind: "review_edited",
      reviewPk: edited,
      sortKey: 10,
    });
    await remember(updated, "777777777777777777");
    await enqueue({ kind: "message_update", reviewPk: updated, sortKey: 20 });
    const { calls } = await drive(
      (index) => ok(String(index + 1)),
      () =>
        runSend(createBudget(Date.now()), {
          config: testConfig({
            pingOnLowRating: { kind: "user", id: USER },
          }),
        }),
    );

    expect(calls.map((call) => call.method)).toEqual(["POST", "PATCH"]);
    expect(calls[0]?.body.nonce).toBe(`o${editedId}`);
    expect(calls[0]?.body.content).toBeUndefined();
    expect(calls[0]?.body.flags).toBe(32768);
    expect(JSON.stringify(calls[0]?.body)).toContain(`<@${USER}>`);
    expect(calls[0]?.body.allowed_mentions).toEqual({
      parse: [],
      users: [USER],
    });
    expect(calls[1]?.body.nonce).toBeUndefined();
    expect(calls[1]?.body.content).toBeUndefined();
    expect(JSON.stringify(calls[1]?.body)).not.toContain(`<@${USER}>`);
    expect(calls[1]?.url).toBe(
      `${DISCORD_API}/channels/${CHANNEL}/messages/777777777777777777`,
    );
  });

  it("posts a message update when no message is stored", async () => {
    const id = await save(review());
    await enqueue({ kind: "message_update", reviewPk: id, sortKey: 1 });
    const { calls } = await drive(
      () => ok("5"),
      () => runSend(createBudget(Date.now())),
    );
    expect(calls.map((call) => call.method)).toEqual(["POST"]);
    expect(await messageCount()).toBe(1);
    expect(await onlyRow()).toMatchObject({ status: "sent" });
  });

  it("backs off a deleted message and does not post a new one", async () => {
    const id = await save(review());
    await remember(id, MESSAGE);
    await enqueue({ kind: "message_update", reviewPk: id, sortKey: 1 });
    const { calls } = await drive(
      () => json(404, { code: 10008 }),
      () => runSend(createBudget(Date.now())),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("PATCH");
    expect(calls[0]?.url).toContain(`/messages/${MESSAGE}`);
    expect(await onlyRow()).toMatchObject({
      status: "pending",
      attempts: 1,
      last_error: "404 gone",
    });
    expect(await messageCount()).toBe(1);
  });

  it("fails a bad Connected payload and still sends the next row", async () => {
    await enqueue({
      kind: "connected",
      reviewPk: null,
      sortKey: 0,
      payload: "not-json",
    });
    await saveQueued(review({ body: "fixture-next" }));
    const { calls, lines } = await drive(
      () => ok("6"),
      () => runSend(createBudget(Date.now())),
    );
    expect(calls).toHaveLength(1);
    expect(description(calls[0])).toBe("fixture-next");
    expect(await rows()).toEqual([
      expect.objectContaining({
        kind: "connected",
        status: "failed",
        last_error: "payload invalid",
      }),
      expect.objectContaining({ kind: "review_new", status: "sent" }),
    ]);
    expect(lines.join("\n")).not.toContain("not-json");
  });

  it("renders the review row as it is when the message is sent", async () => {
    const id = await saveQueued(review({ body: "fixture-old" }));
    await env.DB.prepare("UPDATE reviews SET body = ? WHERE id = ?")
      .bind("fixture-new", id)
      .run();
    const { calls, lines } = await drive(
      () => ok("7"),
      () => runSend(createBudget(Date.now())),
    );
    expect(description(calls[0])).toBe("fixture-new");
    expectQuiet(lines, ["fixture-old", "fixture-new"]);
  });

  it("leaves warning rows pending", async () => {
    await enqueue({ kind: "warning", reviewPk: null, sortKey: -1 });
    await saveQueued(review({ modifiedAt: 50, body: "fixture-ok" }));
    const { calls } = await drive(
      () => ok("8"),
      () => runSend(createBudget(Date.now())),
    );
    expect(calls).toHaveLength(1);
    expect(await rows()).toEqual([
      expect.objectContaining({ kind: "warning", status: "pending" }),
      expect.objectContaining({ kind: "review_new", status: "sent" }),
    ]);
  });
});

type Call = { method: string; url: string; body: Record<string, unknown> };

type OutboxRecord = {
  id: number;
  kind: string;
  status: string;
  sort_key: number;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
};

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    apps: [lune],
    google: {
      clientEmail: "atticus@example.iam.gserviceaccount.com",
      privateKeyPem: "unused",
    },
    discord: {
      botToken: "bot-token",
      applicationId: "123456789012345678",
      publicKey: "ab".repeat(32),
      channelId: CHANNEL,
    },
    allowedUserIds: new Set(["323456789012345678"]),
    translationLanguage: null,
    backfill: "post",
    pingOnLowRating: null,
    timezone: "UTC",
    digest: { enabled: false, day: 1, hour: 9 },
    dryRun: true,
    ...overrides,
  };
}

function review(overrides: Partial<Review> = {}): Review {
  return {
    store: "play",
    appId: APP,
    reviewId: "review-1",
    author: "Avery",
    rating: 4,
    title: null,
    body: "fixture-body",
    originalBody: null,
    language: "en",
    appVersionName: "2.4.0",
    appVersionCode: 120,
    osVersion: "34",
    device: "Sample Phone",
    thumbsUp: 0,
    modifiedAt: 1_700_000_000,
    developerReply: null,
    ...overrides,
  };
}

async function runSend(
  budget: Budget,
  options: {
    nowMs?: number;
    config?: Config;
    markSent?: typeof markOutboxSent;
  } = {},
): Promise<number> {
  const result = await send({
    db: env.DB,
    config: options.config ?? testConfig(),
    notifier: createDiscordNotifier({
      client: createDiscordClient({ botToken: "bot-token", budget }),
      channelId: CHANNEL,
    }),
    budget,
    nowMs: options.nowMs ?? NOW_MS,
    markSent: options.markSent,
  });
  return result.sent;
}

async function drive(
  respond: (index: number) => Response,
  run: (calls: Call[]) => Promise<unknown>,
): Promise<{ calls: Call[]; lines: string[] }> {
  const calls: Call[] = [];
  const lines: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  console.log = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.log;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.text()) as Record<string, unknown>;
    calls.push({ method: request.method, url: request.url, body });
    return respond(calls.length - 1);
  }) as typeof fetch;
  try {
    await run(calls);
    return { calls, lines };
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
}

async function save(next: Review): Promise<number> {
  return insertReviewWithOutbox(env.DB, {
    review: next,
    nowSeconds: NOW,
    enqueue: false,
  });
}

async function saveQueued(next: Review): Promise<number> {
  return insertReviewWithOutbox(env.DB, {
    review: next,
    nowSeconds: NOW,
    enqueue: true,
  });
}

async function enqueue(input: {
  kind: string;
  reviewPk: number | null;
  sortKey: number;
  payload?: string;
}): Promise<number> {
  const result = await env.DB.prepare(
    `INSERT INTO outbox (
       kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
     ) VALUES (?, ?, ?, 'pending', ?, 0, 0, ?)
     RETURNING id`,
  )
    .bind(input.kind, input.reviewPk, input.payload ?? "{}", input.sortKey, NOW)
    .run<{ id: number }>();
  const id = result.results[0]?.id ?? result.meta.last_row_id;
  if (id <= 0) throw new Error("missing outbox id");
  return id;
}

async function remember(reviewPk: number, messageId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (
       review_pk, version, channel_id, message_id, is_latest, created_at
     ) VALUES (?, 1, ?, ?, 1, ?)`,
  )
    .bind(reviewPk, CHANNEL, messageId, NOW)
    .run();
}

async function rows(): Promise<OutboxRecord[]> {
  const result = await env.DB.prepare(
    `SELECT id, kind, status, sort_key, attempts, next_attempt_at, last_error
     FROM outbox ORDER BY sort_key, id`,
  ).all<OutboxRecord>();
  return result.results;
}

async function onlyRow(): Promise<OutboxRecord> {
  const all = await rows();
  const row = all[0];
  if (row === undefined || all.length !== 1) {
    throw new Error(`expected one outbox row, found ${all.length}`);
  }
  return row;
}

async function messageCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

function description(call: Call | undefined): string {
  const found = componentTexts(call?.body.components);
  if (found.length === 1) return found[0] ?? "";
  const body = found.find(
    (text) =>
      !text.startsWith("★") &&
      !text.startsWith("**") &&
      !text.startsWith("App version") &&
      !text.includes("<t:") &&
      !text.startsWith("<@"),
  );
  return body ?? "";
}

function componentTexts(components: unknown): string[] {
  if (!Array.isArray(components)) return [];
  const found: string[] = [];
  for (const component of components) {
    if (!isRecord(component)) continue;
    if (typeof component.content === "string") found.push(component.content);
    if (Array.isArray(component.components)) {
      found.push(...componentTexts(component.components));
    }
  }
  return found;
}

function events(lines: string[]): { event: string; why?: string }[] {
  return lines.map(
    (line) => JSON.parse(line) as { event: string; why?: string },
  );
}

function expectQuiet(lines: string[], banned: readonly string[]): void {
  const text = lines.join("\n");
  for (const word of banned) expect(text).not.toContain(word);
  expect(text).not.toContain("bot-token");
  expect(text).not.toContain(MARKER);
}

function ok(id: string): Response {
  return json(200, { id });
}

function json(status: number, body: unknown): Response {
  return Response.json(body, { status });
}
