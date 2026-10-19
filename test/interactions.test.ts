import {
  createExecutionContext,
  env as testEnv,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Review, StoredReview } from "../src/core/review";
import type { Env } from "../src/env";
import worker from "../src/index";
import {
  EDIT_HINT,
  EMPTY_REPLY,
  GOOGLE_AUTH,
  GOOGLE_REJECTED,
  LABEL,
  MISSING_REVIEW,
  NEW_HINT,
  NOT_ALLOWED,
  NOT_CONFIGURED,
  NOT_SUPPORTED,
  PERMISSION_MISSING,
  PUBLISH_FAILED,
  RATE_LIMITED,
  REVIEW_GONE,
  TOO_LONG,
  WRONG_CHANNEL,
} from "../src/notifiers/discord/copy";
import { replyModal } from "../src/notifiers/discord/modal";
import { clearKeyCache } from "../src/notifiers/discord/verify";
import { clearTokenCache } from "../src/sources/play/auth";
import {
  insertReviewWithOutbox,
  readReview,
  writeBotReply,
} from "../src/store";

const PACKAGE = "com.fusionfroze.Lune";
const EMAIL = "atticus@example.iam.gserviceaccount.com";
const APP = "123456789012345678";
const CHANNEL = "223456789012345678";
const USER = "323456789012345678";
const OTHER = "423456789012345678";
const BOT = "bot-token-should-not-log";
const TOKEN = "interaction-token-should-not-log";
const AUTHOR = "Author Should Not Log";
const REPLY = "Reply text should not log";
const ACCESS = "ya29.TEST_TOKEN_SHOULD_NOT_LOG";
const GOOGLE_BODY = "SECRET_GOOGLE_BODY";
const NOW = 1_700_000_000;

type DiscordKey = { publicKey: string; privateKey: CryptoKey };

type Call = {
  url: string;
  method: string;
  body: string;
  authorization: string | null;
};

type Route = {
  tokenStatus?: number;
  playStatus?: number;
  playNetwork?: boolean;
  discordStatus?: number;
};

let discordKey: DiscordKey;
let pem = "";
const created: number[] = [];
let restoreFetch: (() => void) | null = null;
let restoreLog: (() => void) | null = null;

beforeAll(async () => {
  discordKey = await generateDiscordKey();
  pem = await generatePem();
});

afterEach(async () => {
  restoreFetch?.();
  restoreFetch = null;
  restoreLog?.();
  restoreLog = null;
  clearTokenCache();
  clearKeyCache();
  for (const id of created) {
    await testEnv.DB.prepare("DELETE FROM outbox WHERE review_pk = ?")
      .bind(id)
      .run();
    await testEnv.DB.prepare("DELETE FROM messages WHERE review_pk = ?")
      .bind(id)
      .run();
    await testEnv.DB.prepare("DELETE FROM reviews WHERE id = ?").bind(id).run();
  }
  created.length = 0;
});

describe("reply modal copy", () => {
  it("keeps the title and hints inside Discord's limits", () => {
    const long = replyModal(reviewRow({ author: "N".repeat(80) }));
    expect(Array.from(long.title).length).toBeLessThanOrEqual(45);
    expect(long.title.endsWith("…")).toBe(true);
    expect(replyModal(reviewRow({ author: "  " })).title).toBe(
      "Reply to Anonymous (4★)",
    );
    expect(Array.from(NEW_HINT).length).toBeLessThanOrEqual(100);
    expect(Array.from(EDIT_HINT).length).toBeLessThanOrEqual(100);
    expect(Array.from(LABEL).length).toBeLessThanOrEqual(45);
  });
});

describe("POST /interactions", () => {
  it("returns an empty 401 for a bad signature before parsing", async () => {
    const result = await post("{", {
      signature: "ab".repeat(64),
    });
    expect(result.status).toBe(401);
    expect(result.text).toBe("");
    expect(result.calls).toHaveLength(0);
    expect(result.lines.join("\n")).toContain('"why":"signature"');
    assertClean(result.lines);
  });

  it("returns an empty 401 when the signature header is missing", async () => {
    const result = await post(JSON.stringify({ type: 1 }), {
      signature: null,
    });
    expect(result.status).toBe(401);
    expect(result.text).toBe("");
    expect(result.lines.join("\n")).toContain('"why":"missing"');
  });

  it("returns an empty 401 for a malformed signature", async () => {
    const result = await post(JSON.stringify({ type: 1 }), {
      signature: "abc",
    });
    expect(result.status).toBe(401);
    expect(result.text).toBe("");
    expect(result.lines.join("\n")).toContain('"why":"malformed"');
  });

  it("returns an empty 401 for a timestamp more than 5 minutes off", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 301);
    const result = await post(JSON.stringify({ type: 1 }), { timestamp });
    expect(result.status).toBe(401);
    expect(result.text).toBe("");
    expect(result.calls).toHaveLength(0);
    expect(result.lines.join("\n")).toContain('"why":"stale"');
  });

  it("returns 400 for a signed body that is not JSON", async () => {
    const result = await post("{");
    expect(result.status).toBe(400);
    expect(result.text).toBe("");
    expect(result.calls).toHaveLength(0);
  });

  it("answers PING with PONG", async () => {
    const result = await post(JSON.stringify({ type: 1 }));
    expect(result.status).toBe(200);
    expect(result.contentType).toContain("application/json");
    expect(result.json).toEqual({ type: 1 });
    expect(result.calls).toHaveLength(0);
    expect(result.lines.join("\n")).toContain('"event":"interaction"');
  });

  it("refuses a user who is not on the allow-list", async () => {
    const review = await insertReview();
    const result = await post(
      JSON.stringify(component(`reply:${review.id}`, OTHER)),
    );
    expect(result.json).toMatchObject({
      type: 4,
      data: {
        content: NOT_ALLOWED,
        flags: 64,
        allowed_mentions: { parse: [] },
      },
    });
    expect(result.calls).toHaveLength(0);
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: null,
    });
    assertClean(result.lines);
  });

  it("refuses an interaction with no user", async () => {
    const result = await post(
      JSON.stringify({
        type: 3,
        channel_id: CHANNEL,
        data: { custom_id: "reply:1" },
        token: TOKEN,
      }),
    );
    expect(result.json).toMatchObject({
      type: 4,
      data: { content: NOT_ALLOWED },
    });
  });

  it("refuses the wrong channel and a missing channel", async () => {
    const review = await insertReview();
    const wrong = await post(
      JSON.stringify(
        component(`reply:${review.id}`, USER, "523456789012345678"),
      ),
    );
    expect(wrong.json).toMatchObject({
      type: 4,
      data: { content: WRONG_CHANNEL, flags: 64 },
    });
    const missing = await post(
      JSON.stringify({
        type: 3,
        member: { user: { id: USER } },
        data: { custom_id: `reply:${review.id}` },
        token: TOKEN,
      }),
    );
    expect(missing.json).toMatchObject({
      type: 4,
      data: { content: WRONG_CHANNEL },
    });
    expect(wrong.calls).toHaveLength(0);
    expect(missing.calls).toHaveLength(0);
  });

  it("refuses an unknown custom id and an unknown type", async () => {
    const unknown = await post(JSON.stringify(component("nope")));
    expect(unknown.json).toMatchObject({
      type: 4,
      data: { content: NOT_SUPPORTED },
    });
    const command = await post(
      JSON.stringify({
        type: 2,
        channel_id: CHANNEL,
        member: { user: { id: USER } },
        data: { name: "reviews" },
        token: TOKEN,
      }),
    );
    expect(command.json).toMatchObject({
      type: 4,
      data: { content: NOT_SUPPORTED },
    });
    expect(unknown.lines.join("\n")).toContain('"why":"unknown"');
  });

  it("opens a Reply modal", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(component(`reply:${review.id}`)));
    expect(result.json).toMatchObject({
      type: 9,
      data: {
        custom_id: `reply-modal:${review.id}`,
        title: `Reply to ${AUTHOR} (4★)`,
        components: [
          {
            type: 18,
            label: LABEL,
            description: NEW_HINT,
            component: {
              type: 4,
              custom_id: "reply-text",
              style: 2,
              min_length: 1,
              max_length: 350,
              required: true,
            },
          },
        ],
      },
    });
    const data = record(result.json, "data");
    const label = record(data.components, "0");
    const input = record(label.component);
    expect(input.value).toBeUndefined();
    expect(result.calls).toHaveLength(0);
    assertClean(result.lines);
  });

  it("opens an Edit reply modal prefilled from D1", async () => {
    const review = await insertReview({
      developerReply: { text: REPLY, modifiedAt: 40 },
    });
    const result = await post(JSON.stringify(component(`reply:${review.id}`)));
    expect(result.json).toMatchObject({
      type: 9,
      data: {
        components: [
          {
            description: EDIT_HINT,
            component: { value: REPLY },
          },
        ],
      },
    });
    assertClean(result.lines);
  });

  it("lets an allow-listed DM user open the modal", async () => {
    const review = await insertReview();
    const result = await post(
      JSON.stringify({
        type: 3,
        channel_id: CHANNEL,
        user: { id: USER },
        data: { custom_id: `reply:${review.id}` },
        token: TOKEN,
      }),
    );
    expect(result.json).toMatchObject({ type: 9 });
  });

  it("refuses a missing review and an app that is not configured", async () => {
    const missing = await post(JSON.stringify(component("reply:999999")));
    expect(missing.json).toMatchObject({
      type: 4,
      data: { content: MISSING_REVIEW },
    });
    const review = await insertReview({ appId: "com.other.App" });
    const other = await post(JSON.stringify(component(`reply:${review.id}`)));
    expect(other.json).toMatchObject({
      type: 4,
      data: { content: NOT_CONFIGURED },
    });
    expect(missing.calls).toHaveLength(0);
    expect(other.calls).toHaveLength(0);
  });

  it("refuses a non-canonical id", async () => {
    const result = await post(JSON.stringify(component("reply:01")));
    expect(result.json).toMatchObject({
      type: 4,
      data: { content: NOT_SUPPORTED },
    });
  });

  it("publishes a reply, writes D1, and edits the message once", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(modal(review.id, `  ${REPLY}  `)));
    expect(result.json).toEqual({ type: 6 });
    expect(playCalls(result.calls)).toHaveLength(1);
    expect(JSON.parse(playCalls(result.calls)[0]?.body ?? "{}")).toEqual({
      replyText: REPLY,
    });
    expect(patches(result.calls)).toHaveLength(1);
    expect(followUps(result.calls)).toHaveLength(0);
    const patch = JSON.parse(patches(result.calls)[0]?.body ?? "{}") as {
      flags?: number;
      content?: string;
      allowed_mentions?: { parse?: string[]; users?: string[] };
    };
    expect(patch.flags).toBe(32768);
    expect(patch.content).toBeUndefined();
    expect(patch.allowed_mentions).toEqual({ parse: [] });
    expect(patches(result.calls)[0]?.authorization).toBeNull();
    const wire = JSON.stringify(patch);
    expect(wire).toContain(`**Your reply**\\n${REPLY}`);
    expect(wire).toContain("Edit reply");
    expect(wire).toContain(`reply:${review.id}`);
    expect(wire).not.toContain('"users"');
    const row = await readReview(testEnv.DB, review.id);
    expect(row).toMatchObject({
      replyText: REPLY,
      repliedVia: "bot",
      repliedBy: USER,
    });
    expect(row?.repliedAt).toBe(row?.replyModifiedAt);
    expect(result.lines.join("\n")).toContain('"event":"reply_published"');
    assertClean(result.lines);
  });

  it("accepts a reply of exactly 350 characters", async () => {
    const review = await insertReview();
    const text = "b".repeat(350);
    const result = await post(JSON.stringify(modal(review.id, text)));
    expect(result.json).toEqual({ type: 6 });
    expect(JSON.parse(playCalls(result.calls)[0]?.body ?? "{}")).toEqual({
      replyText: text,
    });
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: text,
    });
  });

  it.each([
    [400, GOOGLE_REJECTED],
    [403, PERMISSION_MISSING],
    [404, REVIEW_GONE],
    [429, RATE_LIMITED],
    [503, PUBLISH_FAILED],
  ] as const)(
    "follows up for Play %s and leaves D1 unchanged",
    async (status, content) => {
      const review = await insertReview();
      const result = await post(JSON.stringify(modal(review.id, REPLY)), {
        route: { playStatus: status },
      });
      expect(result.json).toEqual({ type: 6 });
      expect(playCalls(result.calls)).toHaveLength(1);
      expect(patches(result.calls)).toHaveLength(0);
      expect(followUps(result.calls)).toHaveLength(1);
      expect(
        JSON.parse(followUps(result.calls)[0]?.body ?? "{}"),
      ).toMatchObject({
        content,
        flags: 64,
        allowed_mentions: { parse: [] },
      });
      expect(followUps(result.calls)[0]?.authorization).toBeNull();
      expect(await readReview(testEnv.DB, review.id)).toMatchObject({
        replyText: null,
        repliedVia: null,
      });
      expect(result.lines.join("\n")).toContain('"event":"reply_failed"');
      assertClean(result.lines);
    },
  );

  it("follows up when Google auth fails and does not call Play", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(modal(review.id, REPLY)), {
      route: { tokenStatus: 401 },
    });
    expect(result.json).toEqual({ type: 6 });
    expect(playCalls(result.calls)).toHaveLength(0);
    expect(JSON.parse(followUps(result.calls)[0]?.body ?? "{}")).toMatchObject({
      content: GOOGLE_AUTH,
    });
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: null,
    });
    assertClean(result.lines);
  });

  it("follows up when the Play call cannot connect", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(modal(review.id, REPLY)), {
      route: { playNetwork: true },
    });
    expect(playCalls(result.calls)).toHaveLength(1);
    expect(JSON.parse(followUps(result.calls)[0]?.body ?? "{}")).toMatchObject({
      content: PUBLISH_FAILED,
    });
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: null,
    });
    assertClean(result.lines);
  });

  it("shows a dry run without calling Play or writing D1", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(modal(review.id, REPLY)), {
      env: { DRY_RUN: true },
    });
    expect(result.json).toEqual({ type: 6 });
    expect(
      result.calls.some((call) => call.url.includes("googleapis.com")),
    ).toBe(false);
    expect(patches(result.calls)).toHaveLength(1);
    const wire = patches(result.calls)[0]?.body ?? "";
    expect(wire).toContain("Dry run, not published.");
    expect(wire).toContain(REPLY);
    expect(wire).toContain('"label":"Reply"');
    expect(wire).not.toContain("Edit reply");
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: null,
      repliedVia: null,
    });
    expect(result.lines.join("\n")).toContain('"event":"reply_dry_run"');
    assertClean(result.lines);
  });

  it("rejects text over 350 and whitespace before deferring", async () => {
    const review = await insertReview();
    const over = await post(JSON.stringify(modal(review.id, "c".repeat(351))));
    expect(over.json).toMatchObject({
      type: 4,
      data: { content: TOO_LONG, flags: 64 },
    });
    expect(over.calls).toHaveLength(0);
    const blank = await post(JSON.stringify(modal(review.id, "  \n  ")));
    expect(blank.json).toMatchObject({
      type: 4,
      data: { content: EMPTY_REPLY },
    });
    expect(blank.calls).toHaveLength(0);
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: null,
    });
  });

  it("logs a duplicate and still posts the same text once", async () => {
    const review = await insertReview();
    await writeBotReply(testEnv.DB, {
      id: review.id,
      text: REPLY,
      userId: USER,
      nowSeconds: NOW,
    });
    const result = await post(JSON.stringify(modal(review.id, REPLY)));
    expect(playCalls(result.calls)).toHaveLength(1);
    expect(result.lines.join("\n")).toContain('"event":"reply_duplicate"');
    expect(result.lines.join("\n")).not.toContain('"event":"reply_published"');
    const row = await readReview(testEnv.DB, review.id);
    expect(row?.replyText).toBe(REPLY);
    expect(row?.repliedAt).not.toBe(NOW);
    assertClean(result.lines);
  });

  it("keeps the D1 write when the message edit returns 404", async () => {
    const review = await insertReview();
    const result = await post(JSON.stringify(modal(review.id, REPLY)), {
      route: { discordStatus: 404 },
    });
    expect(playCalls(result.calls)).toHaveLength(1);
    expect(followUps(result.calls)).toHaveLength(0);
    expect(await readReview(testEnv.DB, review.id)).toMatchObject({
      replyText: REPLY,
      repliedVia: "bot",
    });
    expect(result.lines.join("\n")).toContain(
      '"event":"reply_message_edit_failed"',
    );
    expect(result.lines.join("\n")).toContain('"kind":"gone"');
    assertClean(result.lines);
  });

  it("returns a generic 500 when config is invalid", async () => {
    const marker = "UNIQUE_KEY_MATERIAL_z9Q";
    const result = await post(JSON.stringify({ type: 1 }), {
      env: {
        DISCORD_CHANNEL_ID: undefined,
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          client_email: EMAIL,
          private_key: marker,
        }),
      },
    });
    expect(result.status).toBe(500);
    expect(result.text).toBe("Internal Server Error");
    expect(result.text).not.toContain("DISCORD_CHANNEL_ID");
    expect(result.calls).toHaveLength(0);
    const logged = result.lines.join("\n");
    expect(logged).toContain('"event":"config_invalid"');
    expect(logged).toContain("DISCORD_CHANNEL_ID");
    expect(logged).not.toContain(marker);
    expect(logged).not.toContain(BOT);
  });
});

function component(customId: string, userId = USER, channelId = CHANNEL) {
  return {
    type: 3,
    channel_id: channelId,
    member: { user: { id: userId } },
    data: { custom_id: customId, component_type: 2 },
    token: TOKEN,
  };
}

function modal(id: number, text: string) {
  return {
    type: 5,
    channel_id: CHANNEL,
    member: { user: { id: USER } },
    data: {
      custom_id: `reply-modal:${id}`,
      components: [
        {
          type: 18,
          component: { type: 4, custom_id: "reply-text", value: text },
        },
      ],
    },
    token: TOKEN,
  };
}

async function post(
  raw: string,
  options: {
    env?: Partial<Env>;
    route?: Route;
    timestamp?: string;
    signature?: string | null;
  } = {},
): Promise<{
  status: number;
  text: string;
  json: unknown;
  contentType: string;
  calls: Call[];
  lines: string[];
}> {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature =
    options.signature === undefined
      ? await sign(discordKey.privateKey, timestamp, raw)
      : options.signature;
  const headers = new Headers();
  if (signature !== null) headers.set("x-signature-ed25519", signature);
  headers.set("x-signature-timestamp", timestamp);
  const calls = installFetch(options.route ?? {});
  const lines = captureLog();
  const ctx = createExecutionContext();
  try {
    const response = await worker.fetch(
      new Request("https://atticus.test/interactions", {
        method: "POST",
        headers,
        body: raw,
      }),
      makeEnv(options.env),
      ctx,
    );
    await waitOnExecutionContext(ctx);
    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return {
      status: response.status,
      text,
      json,
      contentType: response.headers.get("content-type") ?? "",
      calls,
      lines,
    };
  } finally {
    restoreFetch?.();
    restoreFetch = null;
    restoreLog?.();
    restoreLog = null;
  }
}

function makeEnv(extra: Partial<Env> = {}): Env {
  const env: Env = {
    DB: testEnv.DB,
    APPS: [
      {
        store: "play",
        id: PACKAGE,
        name: "Lune",
        consoleUrl: "https://example.com/console",
      },
    ],
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: EMAIL,
      private_key: pem,
    }),
    DISCORD_BOT_TOKEN: BOT,
    DISCORD_APPLICATION_ID: APP,
    DISCORD_PUBLIC_KEY: discordKey.publicKey,
    DISCORD_CHANNEL_ID: CHANNEL,
    ALLOWED_USER_IDS: USER,
  };
  return { ...env, ...extra };
}

async function insertReview(
  overrides: Partial<Review> = {},
): Promise<StoredReview> {
  const review: Review = {
    store: "play",
    appId: PACKAGE,
    reviewId: `v14-${crypto.randomUUID()}`,
    author: AUTHOR,
    rating: 4,
    title: null,
    body: "A calm evening.",
    originalBody: null,
    language: "en",
    appVersionName: null,
    appVersionCode: null,
    osVersion: null,
    device: null,
    thumbsUp: 0,
    modifiedAt: NOW,
    developerReply: null,
    ...overrides,
  };
  const id = await insertReviewWithOutbox(testEnv.DB, {
    review,
    nowSeconds: NOW,
    enqueue: false,
  });
  created.push(id);
  const stored = await readReview(testEnv.DB, id);
  if (stored === null) throw new Error("insert failed");
  return stored;
}

function installFetch(route: Route): Call[] {
  const calls: Call[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = await request.clone().text();
    calls.push({
      url: request.url,
      method: request.method,
      body,
      authorization: request.headers.get("authorization"),
    });
    const url = new URL(request.url);
    if (url.origin === "https://oauth2.googleapis.com") {
      if (route.tokenStatus !== undefined && route.tokenStatus !== 200) {
        return new Response(GOOGLE_BODY, { status: route.tokenStatus });
      }
      return Response.json({
        access_token: ACCESS,
        expires_in: 3600,
        token_type: "Bearer",
      });
    }
    if (url.hostname === "www.googleapis.com") {
      if (route.playNetwork) throw new TypeError("network");
      if (route.playStatus !== undefined && route.playStatus !== 200) {
        return new Response(GOOGLE_BODY, { status: route.playStatus });
      }
      return Response.json({ result: { replyText: "ignored" } });
    }
    if (url.origin === "https://discord.com") {
      if (route.discordStatus !== undefined && route.discordStatus !== 200) {
        return Response.json(
          { message: "missing" },
          { status: route.discordStatus },
        );
      }
      return Response.json({ id: "900000000000000000" });
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = previous;
  };
  return calls;
}

function captureLog(): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.log;
  restoreLog = () => {
    console.log = original;
  };
  return lines;
}

function playCalls(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.includes(":reply"));
}

function patches(calls: Call[]): Call[] {
  return calls.filter((call) => call.url.endsWith("/messages/@original"));
}

function followUps(calls: Call[]): Call[] {
  return calls.filter(
    (call) =>
      call.url.startsWith("https://discord.com/api/v10/webhooks/") &&
      !call.url.endsWith("/messages/@original"),
  );
}

function assertClean(lines: string[]): void {
  const text = lines.join("\n");
  expect(text).not.toContain(AUTHOR);
  expect(text).not.toContain(REPLY);
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(ACCESS);
  expect(text).not.toContain(GOOGLE_BODY);
  expect(text).not.toContain(BOT);
  expect(text).not.toContain("BEGIN PRIVATE KEY");
}

function record(value: unknown, key?: string): Record<string, unknown> {
  const target =
    key === undefined ? value : (value as Record<string, unknown>)[key];
  if (typeof target !== "object" || target === null) {
    throw new Error("expected an object");
  }
  return target as Record<string, unknown>;
}

function reviewRow(overrides: Partial<StoredReview>): StoredReview {
  return {
    id: 7,
    store: "play",
    appId: PACKAGE,
    reviewId: "review-1",
    rating: 4,
    previousRating: null,
    title: null,
    body: "A calm evening.",
    originalBody: null,
    language: "en",
    author: AUTHOR,
    appVersionName: null,
    appVersionCode: null,
    osVersion: null,
    device: null,
    thumbsUp: 0,
    modifiedAt: NOW,
    firstSeenAt: NOW,
    replyText: null,
    replyModifiedAt: null,
    repliedVia: null,
    repliedBy: null,
    repliedAt: null,
    ...overrides,
  };
}

async function generateDiscordKey(): Promise<DiscordKey> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("expected an Ed25519 key pair");
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected raw public key");
  return {
    publicKey: toHex(new Uint8Array(raw)),
    privateKey: pair.privateKey,
  };
}

async function sign(
  privateKey: CryptoKey,
  timestamp: string,
  body: string,
): Promise<string> {
  const raw = await crypto.subtle.sign(
    { name: "Ed25519" },
    privateKey,
    new TextEncoder().encode(timestamp + body),
  );
  if (!(raw instanceof ArrayBuffer)) throw new Error("expected a signature");
  return toHex(new Uint8Array(raw));
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
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
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected PKCS#8");
  const pkcs8 = new Uint8Array(exported);
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const encoded = btoa(binary);
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 64) {
    lines.push(encoded.slice(index, index + 64));
  }
  return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}
