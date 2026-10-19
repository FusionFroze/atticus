import type { Config } from "../config/types";
import type { StoredReview } from "../core/review";
import type { Budget } from "../lib/budget";
import { log } from "../lib/log";
import { isRecord } from "../lib/record";
import type {
  NoticeInput,
  Notifier,
  ReviewMessageInput,
  SendFailure,
  SendResult,
} from "../notifiers/types";
import {
  claimPending,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSent,
  type OutboxRow,
  readLatestMessage,
  readReview,
  setState,
} from "../store";

const SEND_KINDS = [
  "review_new",
  "review_edited",
  "message_update",
  "connected",
] as const;

// attempts is 0 before the first failure. The fifth failure has no further delay.
const RETRY_BACKOFF_SECONDS = [60, 300, 900, 3600] as const;

const CHANNEL_WARN = "warn:discord_channel";

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
  if (row.kind === "connected") {
    return deliverConnected(input, row, nowSeconds, markSent);
  }
  return deliverReview(input, row, nowSeconds, markSent);
}

async function deliverConnected(
  input: { db: D1Database; notifier: Notifier },
  row: OutboxRow,
  nowSeconds: number,
  markSent: typeof markOutboxSent,
): Promise<Step> {
  const notice = connectedNotice(row.payload);
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
  if (row.reviewPk === null) {
    await failRow(input.db, row, "review missing");
    return "next";
  }
  const review = await readReview(input.db, row.reviewPk);
  if (review === null) {
    await failRow(input.db, row, "review missing");
    return "next";
  }
  const result = await postOrEdit(
    input.db,
    input.notifier,
    row,
    reviewMessage(input.config, review, row.kind),
  );
  if (!result.ok)
    return applyFailure(input.db, row, result.failure, nowSeconds);
  await finishSent(
    input.db,
    row,
    result,
    review.modifiedAt,
    nowSeconds,
    markSent,
  );
  return "sent";
}

async function postOrEdit(
  db: D1Database,
  notifier: Notifier,
  row: OutboxRow,
  message: ReviewMessageInput,
): Promise<SendResult> {
  if (row.kind === "message_update" && row.reviewPk !== null) {
    const latest = await readLatestMessage(db, row.reviewPk);
    if (latest !== null) return notifier.updateReview(latest, message);
  }
  return notifier.postReview(message, `o${row.id}`);
}

function reviewMessage(
  config: Config,
  review: StoredReview,
  kind: string,
): ReviewMessageInput {
  const app = config.apps.find(
    (item) => item.store === review.store && item.id === review.appId,
  );
  return {
    review,
    appName: app?.name ?? review.appId,
    consoleUrl: app?.consoleUrl ?? null,
    mention: mentionFor(config, kind, review.rating),
  };
}

function mentionFor(
  config: Config,
  kind: string,
  rating: number,
): ReviewMessageInput["mention"] {
  if (config.pingOnLowRating === null) return null;
  if (kind !== "review_new" && kind !== "review_edited") return null;
  if (rating > 2) return null;
  return config.pingOnLowRating;
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
    await setState(db, CHANNEL_WARN, "1", nowSeconds);
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
