import { type LogValue, log } from "../lib/log";
import type { SourceFailure } from "../sources/types";
import {
  deleteState,
  enqueueNotice,
  getState,
  listStateByPrefix,
  setState,
} from "../store";

const GOOGLE_AUTH = "warn:google_auth";
const DISCORD_CHANNEL = "warn:discord_channel";
const PLAY_FORBIDDEN_PREFIX = "warn:play_forbidden:";

// One flag per persistent failure. The first failure posts once. The first
// success after that posts one recovery. The channel flag is log-only.
export async function noteListFailure(
  db: D1Database,
  app: { id: string; name: string },
  failure: SourceFailure,
  nowSeconds: number,
): Promise<void> {
  if (failure.kind === "budget") return;
  if (failure.kind === "auth") {
    await raiseGoogleAuth(db, nowSeconds);
    return;
  }
  await clearGoogleAuth(db, nowSeconds);
  if (failure.kind === "forbidden") {
    await raisePlayForbidden(db, app, nowSeconds);
  }
}

export async function noteListSuccess(
  db: D1Database,
  appId: string,
  nowSeconds: number,
): Promise<void> {
  await clearGoogleAuth(db, nowSeconds);
  await clearPlayForbidden(db, appId, nowSeconds);
}

// A removed app can no longer succeed on its own, so its flag clears here.
export async function noteRemovedApps(
  db: D1Database,
  apps: readonly { id: string }[],
  nowSeconds: number,
): Promise<void> {
  const present = new Set(apps.map((app) => app.id));
  const flags = await listStateByPrefix(db, PLAY_FORBIDDEN_PREFIX);
  for (const flag of flags) {
    const appId = flag.key.slice(PLAY_FORBIDDEN_PREFIX.length);
    if (appId === "" || present.has(appId)) continue;
    await clearPlayForbidden(db, appId, nowSeconds);
  }
}

export async function raiseDiscordChannel(
  db: D1Database,
  nowSeconds: number,
): Promise<void> {
  if ((await getState(db, DISCORD_CHANNEL)) !== null) return;
  await setState(db, DISCORD_CHANNEL, "1", nowSeconds);
  log("warning_raised", { kind: "discord_channel" });
}

export async function clearDiscordChannel(db: D1Database): Promise<void> {
  if ((await getState(db, DISCORD_CHANNEL)) === null) return;
  await deleteState(db, DISCORD_CHANNEL);
  log("warning_cleared", { kind: "discord_channel" });
}

async function raiseGoogleAuth(
  db: D1Database,
  nowSeconds: number,
): Promise<void> {
  await raise(db, {
    key: GOOGLE_AUTH,
    value: "1",
    nowSeconds,
    payload: JSON.stringify({ notice: "warning", warning: "google_auth" }),
    fields: { kind: "google_auth" },
  });
}

async function raisePlayForbidden(
  db: D1Database,
  app: { id: string; name: string },
  nowSeconds: number,
): Promise<void> {
  await raise(db, {
    key: `${PLAY_FORBIDDEN_PREFIX}${app.id}`,
    value: app.name,
    nowSeconds,
    payload: JSON.stringify({
      notice: "warning",
      warning: "play_forbidden",
      appId: app.id,
    }),
    fields: { kind: "play_forbidden", appId: app.id },
  });
}

async function clearGoogleAuth(
  db: D1Database,
  nowSeconds: number,
): Promise<void> {
  if ((await getState(db, GOOGLE_AUTH)) === null) return;
  await deleteState(db, GOOGLE_AUTH);
  await enqueueNotice(db, {
    kind: "recovered",
    payload: JSON.stringify({ notice: "recovered", subject: "google_auth" }),
    nowSeconds,
  });
  log("warning_cleared", { kind: "google_auth" });
}

async function clearPlayForbidden(
  db: D1Database,
  appId: string,
  nowSeconds: number,
): Promise<void> {
  const key = `${PLAY_FORBIDDEN_PREFIX}${appId}`;
  const appName = await getState(db, key);
  if (appName === null) return;
  await deleteState(db, key);
  await enqueueNotice(db, {
    kind: "recovered",
    payload: JSON.stringify({
      notice: "recovered",
      subject: "play_forbidden",
      appName,
    }),
    nowSeconds,
  });
  log("warning_cleared", { kind: "play_forbidden", appId });
}

async function raise(
  db: D1Database,
  input: {
    key: string;
    value: string;
    nowSeconds: number;
    payload: string;
    fields: Record<string, LogValue>;
  },
): Promise<void> {
  if ((await getState(db, input.key)) !== null) return;
  await setState(db, input.key, input.value, input.nowSeconds);
  await enqueueNotice(db, {
    kind: "warning",
    payload: input.payload,
    nowSeconds: input.nowSeconds,
  });
  log("warning_raised", input.fields);
}
