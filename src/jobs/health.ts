import { type LogValue, log } from "../lib/log";
import type { SourceFailure } from "../sources/types";
import { deleteState, enqueueNotice, setState } from "../store";
import type { RunState } from "./run-state";

const GOOGLE_AUTH = "warn:google_auth";
const DISCORD_CHANNEL = "warn:discord_channel";
const PLAY_FORBIDDEN_PREFIX = "warn:play_forbidden:";

// One flag per persistent failure. The first failure posts once. The first
// success after that posts one recovery. The channel flag is log-only.
// Flags are read from the run's state and written to D1 and the run's state.
export async function noteListFailure(
  db: D1Database,
  state: RunState,
  app: { id: string; name: string },
  failure: SourceFailure,
  nowSeconds: number,
): Promise<void> {
  if (failure.kind === "budget") return;
  if (failure.kind === "auth") {
    await raiseGoogleAuth(db, state, nowSeconds);
    return;
  }
  await clearGoogleAuth(db, state, nowSeconds);
  if (failure.kind === "forbidden") {
    await raisePlayForbidden(db, state, app, nowSeconds);
  }
}

export async function noteListSuccess(
  db: D1Database,
  state: RunState,
  appId: string,
  nowSeconds: number,
): Promise<void> {
  await clearGoogleAuth(db, state, nowSeconds);
  await clearPlayForbidden(db, state, appId, nowSeconds);
}

// A removed app can no longer succeed on its own, so its flag clears here.
export async function noteRemovedApps(
  db: D1Database,
  state: RunState,
  apps: readonly { id: string }[],
  nowSeconds: number,
): Promise<void> {
  const present = new Set(apps.map((app) => app.id));
  for (const key of state.keys(PLAY_FORBIDDEN_PREFIX)) {
    const appId = key.slice(PLAY_FORBIDDEN_PREFIX.length);
    if (appId === "" || present.has(appId)) continue;
    await clearPlayForbidden(db, state, appId, nowSeconds);
  }
}

export async function raiseDiscordChannel(
  db: D1Database,
  state: RunState,
  nowSeconds: number,
): Promise<void> {
  if (state.get(DISCORD_CHANNEL) !== null) return;
  await setState(db, DISCORD_CHANNEL, "1", nowSeconds);
  state.set(DISCORD_CHANNEL, "1");
  log("warning_raised", { kind: "discord_channel" });
}

export async function clearDiscordChannel(
  db: D1Database,
  state: RunState,
): Promise<void> {
  if (state.get(DISCORD_CHANNEL) === null) return;
  await deleteState(db, DISCORD_CHANNEL);
  state.delete(DISCORD_CHANNEL);
  log("warning_cleared", { kind: "discord_channel" });
}

async function raiseGoogleAuth(
  db: D1Database,
  state: RunState,
  nowSeconds: number,
): Promise<void> {
  await raise(db, state, {
    key: GOOGLE_AUTH,
    value: "1",
    nowSeconds,
    payload: JSON.stringify({ notice: "warning", warning: "google_auth" }),
    fields: { kind: "google_auth" },
  });
}

async function raisePlayForbidden(
  db: D1Database,
  state: RunState,
  app: { id: string; name: string },
  nowSeconds: number,
): Promise<void> {
  await raise(db, state, {
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
  state: RunState,
  nowSeconds: number,
): Promise<void> {
  if (state.get(GOOGLE_AUTH) === null) return;
  await deleteState(db, GOOGLE_AUTH);
  state.delete(GOOGLE_AUTH);
  await enqueueNotice(db, {
    kind: "recovered",
    payload: JSON.stringify({ notice: "recovered", subject: "google_auth" }),
    nowSeconds,
  });
  log("warning_cleared", { kind: "google_auth" });
}

async function clearPlayForbidden(
  db: D1Database,
  state: RunState,
  appId: string,
  nowSeconds: number,
): Promise<void> {
  const key = `${PLAY_FORBIDDEN_PREFIX}${appId}`;
  const appName = state.get(key);
  if (appName === null) return;
  await deleteState(db, key);
  state.delete(key);
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
  state: RunState,
  input: {
    key: string;
    value: string;
    nowSeconds: number;
    payload: string;
    fields: Record<string, LogValue>;
  },
): Promise<void> {
  if (state.get(input.key) !== null) return;
  await setState(db, input.key, input.value, input.nowSeconds);
  state.set(input.key, input.value);
  await enqueueNotice(db, {
    kind: "warning",
    payload: input.payload,
    nowSeconds: input.nowSeconds,
  });
  log("warning_raised", input.fields);
}
