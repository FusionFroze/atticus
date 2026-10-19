import type { APIEmbed, APIMessageComponent } from "discord-api-types/v10";
import type { Budget } from "../../lib/budget";
import { isRecord } from "../../lib/record";
import type { MessageRef, SendFailure, SendResult } from "../types";

export const DISCORD_API = "https://discord.com/api/v10";

// V44. Keep this in step with package.json when the version changes.
export const USER_AGENT =
  "DiscordBot (https://github.com/fusionfroze/atticus, 0.1.0)";

// A 429 at or above this is left for the next run. Under it, one retry is allowed.
const RETRY_UNDER_MS = 2_000;

const UNKNOWN_CHANNEL = 10_003;

export type DiscordAllowedMentions = {
  parse?: readonly string[];
  users?: readonly string[];
  roles?: readonly string[];
};

export type DiscordMessageBody = {
  content?: string;
  embeds?: readonly APIEmbed[];
  components?: readonly APIMessageComponent[];
  flags?: number;
  allowedMentions?: DiscordAllowedMentions;
};

export type DiscordClient = {
  createMessage(
    channelId: string,
    body: DiscordMessageBody,
    nonce: string,
  ): Promise<SendResult>;
  editMessage(ref: MessageRef, body: DiscordMessageBody): Promise<SendResult>;
};

type CallInput = {
  method: "POST" | "PATCH";
  url: string;
  channelId: string;
  body: DiscordMessageBody;
  nonce: string | null;
  token: string;
  budget: Budget;
  sleep: (ms: number) => Promise<void>;
};

export function createDiscordClient(input: {
  botToken: string;
  budget: Budget;
  sleep?: (ms: number) => Promise<void>;
}): DiscordClient {
  const wait = input.sleep ?? ((ms: number) => scheduler.wait(ms));
  const shared = {
    token: input.botToken,
    budget: input.budget,
    sleep: wait,
  };

  return {
    createMessage(channelId, body, nonce) {
      return call({
        ...shared,
        method: "POST",
        url: `${DISCORD_API}/channels/${channelId}/messages`,
        channelId,
        body,
        nonce,
      });
    },
    editMessage(ref, body) {
      return call({
        ...shared,
        method: "PATCH",
        url: `${DISCORD_API}/channels/${ref.channelId}/messages/${ref.messageId}`,
        channelId: ref.channelId,
        body,
        nonce: null,
      });
    },
  };
}

async function call(input: CallInput): Promise<SendResult> {
  if (!input.budget.take()) return { ok: false, failure: { kind: "budget" } };
  return attempt(input, false);
}

async function attempt(
  input: CallInput,
  retried: boolean,
): Promise<SendResult> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: input.method,
      headers: {
        authorization: `Bot ${input.token}`,
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      },
      body: JSON.stringify(wireBody(input.body, input.nonce)),
    });
  } catch {
    return { ok: false, failure: { kind: "unavailable", status: 0 } };
  }

  if (response.status === 429) return retryAfterLimit(input, response, retried);

  if (response.status >= 200 && response.status < 300) {
    const id = await readMessageId(response);
    if (id === null) {
      return { ok: false, failure: { kind: "unavailable", status: 200 } };
    }
    return { ok: true, ref: { channelId: input.channelId, messageId: id } };
  }

  const code = response.status === 404 ? await readErrorCode(response) : null;
  if (response.body !== null && response.status !== 404) {
    await response.body.cancel();
  }
  return {
    ok: false,
    failure: mapStatus(response.status, input.method, code),
  };
}

// One retry, and only when Discord's delay is under 2s and the budget can pay for it.
async function retryAfterLimit(
  input: CallInput,
  response: Response,
  retried: boolean,
): Promise<SendResult> {
  const retryAfterMs = await readRetryAfter(response);
  if (retried || retryAfterMs >= RETRY_UNDER_MS || !input.budget.take()) {
    return { ok: false, failure: { kind: "rate_limited", retryAfterMs } };
  }
  await input.sleep(retryAfterMs);
  return attempt(input, true);
}

// parse is always empty. A listed user or role is the only mention that can ping.
function wireBody(
  body: DiscordMessageBody,
  nonce: string | null,
): Record<string, unknown> {
  const allowed: { parse: []; users?: string[]; roles?: string[] } = {
    parse: [],
  };
  const users = body.allowedMentions?.users;
  const roles = body.allowedMentions?.roles;
  if (users !== undefined && users.length > 0) allowed.users = [...users];
  if (roles !== undefined && roles.length > 0) allowed.roles = [...roles];

  const json: Record<string, unknown> = { allowed_mentions: allowed };
  if (body.content !== undefined) json.content = body.content;
  if (body.embeds !== undefined) json.embeds = body.embeds;
  if (body.components !== undefined) json.components = body.components;
  if (body.flags !== undefined) json.flags = body.flags;
  if (nonce !== null) {
    json.nonce = nonce;
    json.enforce_nonce = true;
  }
  return json;
}

function mapStatus(
  status: number,
  method: "POST" | "PATCH",
  code: number | null,
): SendFailure {
  if (status === 400) return { kind: "invalid", status };
  if (status === 401) return { kind: "unavailable", status: 401 };
  if (status === 403) return { kind: "channel" };
  if (status === 404) {
    if (method === "PATCH" && code !== UNKNOWN_CHANNEL) return { kind: "gone" };
    return { kind: "channel" };
  }
  return { kind: "unavailable", status };
}

async function readMessageId(response: Response): Promise<string | null> {
  try {
    const parsed: unknown = await response.json();
    if (
      !isRecord(parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id === ""
    ) {
      return null;
    }
    return parsed.id;
  } catch {
    return null;
  }
}

async function readErrorCode(response: Response): Promise<number | null> {
  try {
    const parsed: unknown = await response.json();
    if (!isRecord(parsed) || typeof parsed.code !== "number") return null;
    return parsed.code;
  } catch {
    return null;
  }
}

async function readRetryAfter(response: Response): Promise<number> {
  let seconds: number | null = null;
  try {
    const parsed: unknown = await response.json();
    if (
      isRecord(parsed) &&
      typeof parsed.retry_after === "number" &&
      Number.isFinite(parsed.retry_after)
    ) {
      seconds = parsed.retry_after;
    }
  } catch {
    seconds = null;
  }
  if (seconds === null) {
    const header = response.headers.get("Retry-After");
    if (header !== null && header !== "") {
      const parsed = Number(header);
      if (Number.isFinite(parsed)) seconds = parsed;
    }
  }
  if (seconds === null || seconds < 0) return RETRY_UNDER_MS;
  return Math.ceil(seconds * 1000);
}
