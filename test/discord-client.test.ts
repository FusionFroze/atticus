import { afterEach, describe, expect, it } from "vitest";
import { createBudget } from "../src/lib/budget";
import {
  createDiscordClient,
  DISCORD_API,
  type DiscordMessageBody,
  USER_AGENT,
} from "../src/notifiers/discord/client";
import type { SendResult } from "../src/notifiers/types";

const TOKEN = "test-bot-token";
const APP = "123456789012345678";
const INTERACTION_TOKEN = "interaction-token-should-not-log";
const CHANNEL = "223456789012345678";
const MESSAGE = "323456789012345678";
const USER = "423456789012345678";
const ROLE = "523456789012345678";
const BODY_MARKER = "UNIQUE_DISCORD_BODY_MARKER";

type Captured = {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
  userAgent: string | null;
  contentType: string | null;
};

const sleepCalls: number[] = [];
let calls: Captured[] = [];
let logs: string[] = [];
let restoreLog: (() => void) | null = null;
let previousFetch: typeof fetch | null = null;

afterEach(() => {
  if (previousFetch !== null) globalThis.fetch = previousFetch;
  previousFetch = null;
  restoreLog?.();
  restoreLog = null;
  calls = [];
  logs = [];
  sleepCalls.length = 0;
});

describe("discord client", () => {
  it("sends the nonce, enforce_nonce, and allowed_mentions on create", async () => {
    const client = clientWith(() => json({ id: MESSAGE }));
    const result = await client.createMessage(
      CHANNEL,
      { content: "hello @everyone", allowedMentions: { parse: ["everyone"] } },
      "o42",
    );

    expect(result).toEqual({
      ok: true,
      ref: { channelId: CHANNEL, messageId: MESSAGE },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("missing call");
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${DISCORD_API}/channels/${CHANNEL}/messages`);
    expect(call.authorization).toBe(`Bot ${TOKEN}`);
    expect(call.userAgent).toBe(USER_AGENT);
    expect(call.contentType).toBe("application/json");
    expect(call.body).toEqual({
      content: "hello @everyone",
      nonce: "o42",
      enforce_nonce: true,
      allowed_mentions: { parse: [] },
    });
    expect(logs.join("\n")).not.toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(BODY_MARKER);
  });

  it("keeps listed users and roles and still clears parse on edit", async () => {
    const client = clientWith(() => json({ id: MESSAGE }));
    await client.editMessage(
      { channelId: CHANNEL, messageId: MESSAGE },
      {
        content: "hello",
        allowedMentions: {
          parse: ["everyone", "users", "roles"],
          users: [USER],
          roles: [ROLE],
        },
      },
    );

    const call = calls[0];
    if (call === undefined) throw new Error("missing call");
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(
      `${DISCORD_API}/channels/${CHANNEL}/messages/${MESSAGE}`,
    );
    expect(call.body).toEqual({
      content: "hello",
      allowed_mentions: { parse: [], users: [USER], roles: [ROLE] },
    });
    expect(call.body).not.toHaveProperty("nonce");
    expect(call.body).not.toHaveProperty("enforce_nonce");
  });

  it("maps a 200 with an id", async () => {
    const client = clientWith(() => json({ id: MESSAGE }, 200));
    await expect(client.createMessage(CHANNEL, {}, "o1")).resolves.toEqual({
      ok: true,
      ref: { channelId: CHANNEL, messageId: MESSAGE },
    });
  });

  it("maps a 201 with an id", async () => {
    const client = clientWith(() => json({ id: MESSAGE }, 201));
    await expect(client.createMessage(CHANNEL, {}, "o1")).resolves.toEqual({
      ok: true,
      ref: { channelId: CHANNEL, messageId: MESSAGE },
    });
  });

  it("maps a 2xx without an id to unavailable 200", async () => {
    const client = clientWith(() => json({ message: BODY_MARKER }));
    await expect(client.createMessage(CHANNEL, {}, "o1")).resolves.toEqual({
      ok: false,
      failure: { kind: "unavailable", status: 200 },
    });
    expect(logged()).not.toContain(BODY_MARKER);
  });

  it("maps 400 to invalid and does not keep the response body", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER, code: 50035 }, 400),
    );
    const result = await client.createMessage(CHANNEL, {}, "o1");
    expect(result).toEqual({
      ok: false,
      failure: { kind: "invalid", status: 400 },
    });
    expect(JSON.stringify(result)).not.toContain(BODY_MARKER);
    expect(logged()).not.toContain(BODY_MARKER);
    expect(logged()).not.toContain(TOKEN);
  });

  it("maps 401 to unavailable", async () => {
    const client = clientWith(() => json({ message: BODY_MARKER }, 401));
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "unavailable",
      status: 401,
    });
    expect(logged()).not.toContain(BODY_MARKER);
  });

  it("maps 403 to channel", async () => {
    const client = clientWith(() => json({ message: BODY_MARKER }, 403));
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "channel",
    });
  });

  it("maps a create 404 to channel", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER, code: 10003 }, 404),
    );
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "channel",
    });
  });

  it("maps an edit 404 for an unknown message to gone", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER, code: 10008 }, 404),
    );
    await expect(failureOf("PATCH", client)).resolves.toEqual({ kind: "gone" });
  });

  it("maps an edit 404 for an unknown channel to channel", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER, code: 10003 }, 404),
    );
    await expect(failureOf("PATCH", client)).resolves.toEqual({
      kind: "channel",
    });
  });

  it("maps an edit 404 without a code to gone", async () => {
    const client = clientWith(() => new Response("nope", { status: 404 }));
    await expect(failureOf("PATCH", client)).resolves.toEqual({ kind: "gone" });
  });

  it("maps 500 and 502 to unavailable", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER }, calls.length === 1 ? 500 : 502),
    );
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "unavailable",
      status: 500,
    });
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "unavailable",
      status: 502,
    });
  });

  it("maps a thrown fetch to unavailable 0 and does not fetch when the budget is spent", async () => {
    const client = clientWith(() => {
      throw new Error(BODY_MARKER);
    });
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "unavailable",
      status: 0,
    });
    expect(logged()).not.toContain(BODY_MARKER);
    expect(logged()).not.toContain(TOKEN);

    const spent = createDiscordClient({
      botToken: TOKEN,
      budget: createBudget(Date.now(), 0),
      sleep: async () => undefined,
    });
    await expect(spent.createMessage(CHANNEL, {}, "o1")).resolves.toEqual({
      ok: false,
      failure: { kind: "budget" },
    });
    expect(calls).toHaveLength(1);
  });

  it("retries a 429 under 2s once", async () => {
    const client = clientWith(() =>
      calls.length === 1
        ? json({ message: BODY_MARKER, retry_after: 0.5 }, 429)
        : json({ id: MESSAGE }),
    );
    const result = await client.createMessage(CHANNEL, {}, "o7");
    expect(result).toEqual({
      ok: true,
      ref: { channelId: CHANNEL, messageId: MESSAGE },
    });
    expect(calls).toHaveLength(2);
    expect(sleepCalls).toEqual([500]);
    expect(calls[1]?.body).toMatchObject({ nonce: "o7", enforce_nonce: true });
    expect(logged()).not.toContain(BODY_MARKER);
  });

  it("does not wait when a short 429 has no budget left", async () => {
    const client = createDiscordClient({
      botToken: TOKEN,
      budget: createBudget(Date.now(), 1),
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });
    installFetch(() => json({ retry_after: 0.5, message: BODY_MARKER }, 429));
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 500,
    });
    expect(calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("does not retry a 429 at 2s", async () => {
    const client = clientWith(
      () =>
        new Response(JSON.stringify({ message: BODY_MARKER }), {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
    );
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
    expect(calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("uses the Retry-After header when the 429 body has no retry_after", async () => {
    const client = clientWith(
      () =>
        new Response(JSON.stringify({ message: BODY_MARKER }), {
          status: 429,
          headers: { "Retry-After": "3" },
        }),
    );
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 3000,
    });
    expect(calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("returns rate_limited when the single retry is also a 429", async () => {
    const client = clientWith(() =>
      json({ message: BODY_MARKER, retry_after: 0.1 }, 429),
    );
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 100,
    });
    expect(calls).toHaveLength(2);
    expect(sleepCalls).toEqual([100]);
  });

  it("edits the interaction message without the bot token", async () => {
    const client = clientWith(() => json({ id: MESSAGE }));
    const result = await client.editOriginal(APP, INTERACTION_TOKEN, {
      content: "updated",
      flags: 32768,
    });
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("missing call");
    expect(call.method).toBe("PATCH");
    expect(call.url).toBe(
      `${DISCORD_API}/webhooks/${APP}/${INTERACTION_TOKEN}/messages/@original`,
    );
    expect(call.authorization).toBeNull();
    expect(call.userAgent).toBe(USER_AGENT);
    expect(call.body).toEqual({
      content: "updated",
      flags: 32768,
      allowed_mentions: { parse: [] },
    });
    expect(logged()).not.toContain(INTERACTION_TOKEN);
    expect(logged()).not.toContain(TOKEN);
  });

  it("sends an ephemeral follow-up without the bot token", async () => {
    const client = clientWith(() => json({ id: MESSAGE }));
    const result = await client.createFollowUp(APP, INTERACTION_TOKEN, "nope");
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (call === undefined) throw new Error("missing call");
    expect(call.method).toBe("POST");
    expect(call.url).toBe(
      `${DISCORD_API}/webhooks/${APP}/${INTERACTION_TOKEN}`,
    );
    expect(call.authorization).toBeNull();
    expect(call.body).toEqual({
      content: "nope",
      flags: 64,
      allowed_mentions: { parse: [] },
    });
    expect(logged()).not.toContain(INTERACTION_TOKEN);
  });

  it("does not call Discord when the budget is already spent", async () => {
    installFetch(() => json({ id: MESSAGE }));
    const client = createDiscordClient({
      botToken: TOKEN,
      budget: createBudget(Date.now(), 0),
    });
    const result = await client.editOriginal(APP, INTERACTION_TOKEN, {});
    expect(result).toEqual({ ok: false, failure: { kind: "budget" } });
    expect(calls).toHaveLength(0);
  });

  it("treats a 429 with no delay as 2s and does not retry", async () => {
    const client = clientWith(() => new Response("limited", { status: 429 }));
    await expect(failureOf("POST", client)).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: 2000,
    });
    expect(sleepCalls).toEqual([]);
  });
});

function clientWith(
  respond: () => Response,
): ReturnType<typeof createDiscordClient> {
  installFetch(respond);
  return createDiscordClient({
    botToken: TOKEN,
    budget: createBudget(Date.now()),
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
  });
}

function installFetch(respond: () => Response): void {
  capture();
  previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const text = await request.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    calls.push({
      url: request.url,
      method: request.method,
      body,
      authorization: request.headers.get("authorization"),
      userAgent: request.headers.get("user-agent"),
      contentType: request.headers.get("content-type"),
    });
    return respond();
  }) as typeof fetch;
}

function capture(): void {
  const original = console.log;
  console.log = ((line: unknown) => {
    logs.push(String(line));
  }) as typeof console.log;
  restoreLog = () => {
    console.log = original;
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function failureOf(
  method: "POST" | "PATCH",
  client: ReturnType<typeof createDiscordClient>,
): Promise<Extract<SendResult, { ok: false }>["failure"]> {
  const body: DiscordMessageBody = {};
  const result =
    method === "POST"
      ? await client.createMessage(CHANNEL, body, "o1")
      : await client.editMessage(
          { channelId: CHANNEL, messageId: MESSAGE },
          body,
        );
  if (result.ok) throw new Error("expected a failure");
  return result.failure;
}

function logged(): string {
  return logs.join("\n");
}
