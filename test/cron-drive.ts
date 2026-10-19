import { env } from "cloudflare:test";
import { expect } from "vitest";
import type { AppConfig, Config } from "../src/config/types";
import { poll } from "../src/jobs/poll";
import { send } from "../src/jobs/send";
import { createBudget } from "../src/lib/budget";
import { isRecord } from "../src/lib/record";
import {
  createDiscordClient,
  DISCORD_API,
} from "../src/notifiers/discord/client";
import { createDiscordNotifier } from "../src/notifiers/discord/notifier";
import { clearTokenCache } from "../src/sources/play/auth";
import { createPlaySource } from "../src/sources/play/source";

export const NOW_MS = 1_800_000_000_000;
export const NOW = 1_800_000_000;
export const CHANNEL = "223456789012345678";
export const GUILD = "623456789012345678";
const EMAIL = "atticus-cron@example.iam.gserviceaccount.com";
const ACCESS_TOKEN = "ya29.CRON_TEST_TOKEN";

export const lune: AppConfig = {
  store: "play",
  id: "com.fusionfroze.Lune",
  name: "Lune",
  consoleUrl: null,
};

export const broken: AppConfig = {
  store: "play",
  id: "com.example.broken",
  name: "Broken",
  consoleUrl: null,
};

export type DiscordCall = {
  method: string;
  url: string;
  body: Record<string, unknown>;
};

let pemPromise: Promise<string> | null = null;

export async function emptyDatabase(): Promise<void> {
  clearTokenCache();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM reviews"),
    env.DB.prepare("DELETE FROM state"),
  ]);
}

export async function withCron(
  handler: (request: Request) => Response | Promise<Response>,
  run: () => Promise<void>,
): Promise<{ lines: string[] }> {
  const lines: string[] = [];
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  console.log = ((line: unknown) => {
    lines.push(String(line));
  }) as typeof console.log;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(new Request(input, init));
  }) as typeof fetch;
  try {
    await run();
    return { lines };
  } finally {
    globalThis.fetch = previousFetch;
    console.log = previousLog;
  }
}

export async function pollApps(
  apps: AppConfig[] = [lune],
  backfill: "post" | "silent" = "post",
): Promise<void> {
  await pollAt({ apps, backfill });
}

export async function pollAt(
  input: {
    apps?: AppConfig[];
    backfill?: "post" | "silent";
    nowMs?: number;
    timezone?: string;
    digest?: Config["digest"];
  } = {},
): Promise<void> {
  const nowMs = input.nowMs ?? NOW_MS;
  const google = { clientEmail: EMAIL, privateKeyPem: await testPem() };
  const config = cronConfig(input.apps ?? [lune], input.backfill ?? "post");
  if (input.timezone !== undefined) config.timezone = input.timezone;
  if (input.digest !== undefined) config.digest = input.digest;
  await poll({
    db: env.DB,
    config,
    source: createPlaySource({ google, translationLanguage: null }),
    budget: createBudget(nowMs),
    nowMs,
  });
}

export async function sendOutbox(apps: AppConfig[] = [lune]): Promise<void> {
  const budget = createBudget(Date.now());
  await send({
    db: env.DB,
    config: cronConfig(apps),
    notifier: createDiscordNotifier({
      client: createDiscordClient({ botToken: "bot-token", budget }),
      channelId: CHANNEL,
    }),
    budget,
    nowMs: NOW_MS,
  });
}

export function isToken(request: Request): boolean {
  return new URL(request.url).origin === "https://oauth2.googleapis.com";
}

export function isDiscord(request: Request): boolean {
  return request.url.startsWith(DISCORD_API);
}

export function tokenResponse(): Response {
  return Response.json({
    access_token: ACCESS_TOKEN,
    expires_in: 3600,
    token_type: "Bearer",
  });
}

export function playList(reviews: unknown[]): Response {
  return Response.json({ reviews });
}

export function playReview(input: {
  reviewId: string;
  text: string;
  rating: number;
  seconds: string;
  reply?: { text: string; seconds: string };
}): { reviewId: string; authorName: string; comments: unknown[] } {
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
  return { reviewId: input.reviewId, authorName: "Fixture Author", comments };
}

export async function readCall(request: Request): Promise<DiscordCall> {
  const text = await request.clone().text();
  let body: Record<string, unknown> = {};
  if (text !== "") body = JSON.parse(text) as Record<string, unknown>;
  return { method: request.method, url: request.url, body };
}

export function labels(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  walk(body.components, (component) => {
    if (typeof component.label === "string") found.push(component.label);
  });
  return found;
}

export function texts(body: Record<string, unknown>): string[] {
  const found: string[] = [];
  walk(body.components, (component) => {
    if (typeof component.content === "string") found.push(component.content);
  });
  return found;
}

export async function latestMessageId(): Promise<string> {
  const row = await env.DB.prepare(
    "SELECT message_id FROM messages WHERE is_latest = 1",
  ).first<{ message_id: string }>();
  if (row === null) throw new Error("missing latest message");
  return row.message_id;
}

export function expectQuiet(lines: string[], banned: readonly string[]): void {
  const text = lines.join("\n");
  for (const word of [
    ...banned,
    ACCESS_TOKEN,
    "bot-token",
    "BEGIN PRIVATE KEY",
  ]) {
    expect(text).not.toContain(word);
  }
}

function walk(
  components: unknown,
  visit: (component: Record<string, unknown>) => void,
): void {
  if (!Array.isArray(components)) return;
  for (const component of components) {
    if (!isRecord(component)) continue;
    visit(component);
    walk(component.components, visit);
  }
}

function cronConfig(
  apps: AppConfig[],
  backfill: "post" | "silent" = "post",
): Config {
  return {
    apps,
    google: { clientEmail: EMAIL, privateKeyPem: "unused" },
    discord: {
      botToken: "bot-token",
      applicationId: "123456789012345678",
      publicKey: "ab".repeat(32),
      channelId: CHANNEL,
    },
    allowedUserIds: new Set(["323456789012345678"]),
    translationLanguage: null,
    backfill,
    pingOnLowRating: null,
    timezone: "UTC",
    digest: { enabled: false, day: 1, hour: 9 },
    dryRun: true,
  };
}

export function testPem(): Promise<string> {
  pemPromise ??= generatePem();
  return pemPromise;
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
  if (!(exported instanceof ArrayBuffer)) {
    throw new Error("expected PKCS#8 bytes");
  }
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
