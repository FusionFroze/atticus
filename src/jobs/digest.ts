import type { Config } from "../config/types";
import { digestStats } from "../core/digest";
import { digestTiming, lastScheduledAt } from "../core/time";
import { log } from "../lib/log";
import { isRecord } from "../lib/record";
import type { DigestInput } from "../notifiers/types";
import {
  DIGEST_LAST_KEY,
  enqueueDigestBatch,
  readDigestRows,
  setState,
} from "../store";
import type { RunState } from "./run-state";

export async function enqueueDueDigests(input: {
  db: D1Database;
  config: Config;
  state: RunState;
  nowMs: number;
}): Promise<void> {
  if (!input.config.digest.enabled) return;
  const scheduled = lastScheduledAt(
    input.nowMs,
    input.config.timezone,
    input.config.digest.day,
    input.config.digest.hour,
  );
  const timing = digestTiming(
    input.nowMs,
    scheduled,
    input.state.get(DIGEST_LAST_KEY),
  );
  if (timing === "done") return;
  const nowSeconds = Math.floor(input.nowMs / 1000);
  if (timing === "late") {
    await setState(input.db, DIGEST_LAST_KEY, scheduled.localDate, nowSeconds);
    input.state.set(DIGEST_LAST_KEY, scheduled.localDate);
    log("digest_skipped", { localDate: scheduled.localDate });
    return;
  }
  const windowEnd = nowSeconds;
  await enqueueDigestBatch(input.db, {
    localDate: scheduled.localDate,
    nowSeconds,
    rows: input.config.apps.map((app) => ({
      payload: JSON.stringify({ appId: app.id, windowEnd }),
      sortKey: windowEnd,
    })),
  });
  input.state.set(DIGEST_LAST_KEY, scheduled.localDate);
  for (const app of input.config.apps) {
    log("digest_enqueued", { appId: app.id, localDate: scheduled.localDate });
  }
}

export async function loadDigest(input: {
  db: D1Database;
  config: Config;
  payload: string;
  guildId: string | null;
}): Promise<DigestInput | null> {
  const parsed = parsePayload(input.payload);
  if (parsed === null) return null;
  const app = input.config.apps.find((item) => item.id === parsed.appId);
  const rows = await readDigestRows(
    input.db,
    { store: app?.store ?? "play", id: parsed.appId },
    parsed.windowEnd,
  );
  const stats = digestStats(rows, parsed.windowEnd);
  const messages = new Map(rows.map((row) => [row.id, row.message] as const));
  return {
    appName: app?.name ?? parsed.appId,
    quiet: stats.quiet,
    newCount: stats.newCount,
    editedCount: stats.editedCount,
    averageRating: stats.averageRating,
    averageChange: stats.averageChange,
    distribution: stats.distribution,
    repliedCount: stats.repliedCount,
    replyRate: stats.replyRate,
    medianReplySeconds: stats.medianReplySeconds,
    versions: stats.versions,
    lowest: stats.lowestUnanswered.map((row) => {
      const message = messages.get(row.id) ?? null;
      return {
        rating: row.rating,
        title: row.title,
        channelId: message?.channelId ?? null,
        messageId: message?.messageId ?? null,
      };
    }),
    guildId: input.guildId,
  };
}

function parsePayload(
  payload: string,
): { appId: string; windowEnd: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.appId !== "string" || parsed.appId.length === 0)
    return null;
  if (
    typeof parsed.windowEnd !== "number" ||
    !Number.isSafeInteger(parsed.windowEnd) ||
    parsed.windowEnd < 0
  ) {
    return null;
  }
  return { appId: parsed.appId, windowEnd: parsed.windowEnd };
}
