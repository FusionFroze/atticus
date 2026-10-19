import type { Config } from "../config/types";
import type { Budget } from "../lib/budget";
import { log } from "../lib/log";
import { isRecord } from "../lib/record";
import type {
  NoticeInput,
  Notifier,
  SendFailure,
  SendResult,
} from "../notifiers/types";
import {
  claimPending,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSent,
  type OutboxRow,
} from "../store";
import { postStoredReview } from "./deliver";
import { clearDiscordChannel, raiseDiscordChannel } from "./health";

const SEND_KINDS = [
  "review_new",
  "review_edited",
  "message_update",
  "connected",
  "warning",
  "recovered",
] as const;

// attempts is 0 before the first failure. The fifth failure has no further delay.
const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3600] as const;

type StopWhy =
  | "rate_limited"
  | "budget"
  | "deadline"
  | "channel"
  | "unauthorized";

type Step = "sent" | "next" | StopWhy;

export async function send(input: {
  db: D1Database;
  config: Config;
  notifier: Notifier;
  budget: Budget;
  nowMs: number;
  markSent?: typeof markOutboxSent;
}): Promise<{ sent: number }> {
  const markSent = input.markSent ?? markOutboxSent;
  const nowSeconds = Math.floor(input.nowMs / 1000);
  let sent = 0;
  try {
    for (;;) {
      const why = halt(input.budget);
      if (why !== null) {
        noteStop(why);
        return { sent };
      }
      const rows = await claimPending(
        input.db,
        nowSeconds,
        input.budget.remaining(),
        SEND_KINDS,
      );
      if (rows.length === 0) return { sent };
      for (const row of rows) {
        const stopped = halt(input.budget);
        if (stopped !== null) {
          noteStop(stopped);
          return { sent };
        }
        const step = await deliver(input, row, nowSeconds, markSent);
        if (step === "sent") {
          sent += 1;
          continue;
        }
        if (step === "next") continue;
        noteStop(step);
        return { sent };
      }
    }
  } catch {
    log("send_stopped", { why: "store" });
    return { sent };
  }
}

function halt(budget: Budget): "deadline" | "budget" | null {
  if (Date.now() >= budget.deadline) return "deadline";
  if (budget.remaining() === 0) return "budget";
  return null;
}

function noteStop(why: StopWhy): void {
  if (why === "budget") log("budget_exhausted");
  log("send_stopped", { why });
}

async function deliver(
  input: {
    db: D1Database;
    config: Config;
    notifier: Notifier;
  },
  row: OutboxRow,
  nowSeconds: number,
  markSent: typeof markOutboxSent,
): Promise<Step> {
  if (
    row.kind === "connected" ||
    row.kind === "warning" ||
    row.kind === "recovered"
  ) {
    return deliverNotice(input, row, nowSeconds, markSent);
  }
  return deliverReview(input, row, nowSeconds, markSent);
}

async function deliverNotice(
  input: { db: D1Database; config: Config; notifier: Notifier },
  row: OutboxRow,
  nowSeconds: number,
  markSent: typeof markOutboxSent,
): Promise<Step> {
  const notice = noticeFrom(input.config, row.kind, row.payload);
  if (notice === null) {
    await failRow(input.db, row, "payload invalid");
    return "next";
  }
  const result = await input.notifier.postNotice(notice, `o${row.id}`);
  if (!result.ok)
    return applyFailure(input.db, row, result.failure, nowSeconds);
  await finishSent(input.db, row, result, 0, nowSeconds, markSent);
  return "sent";
}

async function deliverReview(
  input: { db: D1Database; config: Config; notifier: Notifier },
  row: OutboxRow,
  nowSeconds: number,
  markSent: typeof markOutboxSent,
): Promise<Step> {
  const posted = await postStoredReview(
    input.db,
    input.notifier,
    input.config,
    row,
  );
  if (!posted.ok) {
    await failRow(input.db, row, "review missing");
    return "next";
  }
  if (!posted.result.ok) {
    return applyFailure(input.db, row, posted.result.failure, nowSeconds);
  }
  await finishSent(
    input.db,
    row,
    posted.result,
    posted.modifiedAt,
    nowSeconds,
    markSent,
  );
  return "sent";
}

function noticeFrom(
  config: Config,
  kind: string,
  payload: string,
): NoticeInput | null {
  if (kind === "connected") return connectedNotice(payload);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.notice !== kind) return null;
  if (kind === "warning") return warningNotice(config, parsed);
  if (kind === "recovered") return recoveredNotice(parsed);
  return null;
}

function warningNotice(
  config: Config,
  parsed: Record<string, unknown>,
): Extract<NoticeInput, { kind: "warning" }> | null {
  if (parsed.warning === "google_auth") {
    return { kind: "warning", warning: "google_auth" };
  }
  if (parsed.warning !== "play_forbidden") return null;
  if (typeof parsed.appId !== "string" || parsed.appId.length === 0) {
    return null;
  }
  const named = config.apps.find((app) => app.id === parsed.appId);
  return {
    kind: "warning",
    warning: "play_forbidden",
    appName: named?.name ?? parsed.appId,
  };
}

function recoveredNotice(
  parsed: Record<string, unknown>,
): Extract<NoticeInput, { kind: "recovered" }> | null {
  if (parsed.subject === "google_auth") {
    return { kind: "recovered", subject: "google_auth" };
  }
  if (parsed.subject !== "play_forbidden") return null;
  if (typeof parsed.appName !== "string" || parsed.appName.length === 0) {
    return null;
  }
  return {
    kind: "recovered",
    subject: "play_forbidden",
    appName: parsed.appName,
  };
}

function connectedNotice(
  payload: string,
): Extract<NoticeInput, { kind: "connected" }> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { appName, count, backfill } = parsed;
  if (typeof appName !== "string" || appName.length === 0) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return null;
  }
  if (backfill !== "post" && backfill !== "silent") return null;
  return { kind: "connected", appName, count, backfill };
}

async function applyFailure(
  db: D1Database,
  row: OutboxRow,
  failure: SendFailure,
  nowSeconds: number,
): Promise<Step> {
  if (failure.kind === "rate_limited") return "rate_limited";
  if (failure.kind === "budget") return "budget";
  if (failure.kind === "channel") {
    await raiseDiscordChannel(db, nowSeconds);
    return "channel";
  }
  if (failure.kind === "unavailable" && failure.status === 401) {
    return "unauthorized";
  }
  if (failure.kind === "invalid") {
    await failRow(db, row, `${failure.status} invalid`);
    return "next";
  }
  await retryRow(db, row, nowSeconds, failureLabel(failure));
  return "next";
}

function failureLabel(failure: SendFailure): string {
  if (failure.kind === "gone") return "404 gone";
  if (failure.kind === "unavailable") return `${failure.status} unavailable`;
  return failure.kind;
}

async function finishSent(
  db: D1Database,
  row: OutboxRow,
  result: Extract<SendResult, { ok: true }>,
  version: number,
  nowSeconds: number,
  markSent: typeof markOutboxSent,
): Promise<void> {
  await markSent(db, {
    outboxId: row.id,
    reviewPk: row.reviewPk,
    channelId: result.ref.channelId,
    messageId: result.ref.messageId,
    version,
    nowSeconds,
  });
  await clearDiscordChannel(db);
  log("outbox_sent", { outboxId: row.id, kind: row.kind });
}

async function failRow(
  db: D1Database,
  row: OutboxRow,
  lastError: string,
): Promise<void> {
  await markOutboxFailed(db, row.id, lastError);
  log("outbox_failed", { outboxId: row.id, kind: row.kind });
}

async function retryRow(
  db: D1Database,
  row: OutboxRow,
  nowSeconds: number,
  lastError: string,
): Promise<void> {
  const delay = RETRY_BACKOFF_SECONDS[row.attempts];
  if (delay === undefined) {
    await failRow(db, row, lastError);
    return;
  }
  await markOutboxRetry(db, row.id, nowSeconds + delay, lastError);
  log("outbox_retry", { outboxId: row.id, kind: row.kind });
}
