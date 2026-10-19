import type { AppConfig } from "../config/types";
import type { StoredReview } from "../core/review";
import type { Budget } from "../lib/budget";
import { log } from "../lib/log";
import type { ReviewSource, SourceFailure } from "../sources/types";
import { writeBotReply } from "../store";

const REPLY_LIMIT = 350;

export type ReplyOutcome = "published" | "duplicate" | "dry_run";

export type PublishResult =
  | { ok: true; outcome: ReplyOutcome; review: StoredReview; text: string }
  | { ok: false; failure: SourceFailure };

export function validateReplyText(
  text: string,
): { ok: true; text: string } | { ok: false; reason: "empty" | "too_long" } {
  const trimmed = text.trim();
  const length = Array.from(trimmed).length;
  if (length < 1) return { ok: false, reason: "empty" };
  if (length > REPLY_LIMIT) return { ok: false, reason: "too_long" };
  return { ok: true, text: trimmed };
}

// One Play POST, then one D1 update. A failure does not write and is not retried.
export async function publishReply(input: {
  db: D1Database;
  source: ReviewSource;
  app: AppConfig;
  review: StoredReview;
  userId: string;
  text: string;
  dryRun: boolean;
  budget: Budget;
  nowMs: number;
}): Promise<PublishResult> {
  const validated = validateReplyText(input.text);
  if (!validated.ok) {
    return {
      ok: false,
      failure: {
        kind: "invalid",
        detail: validated.reason === "empty" ? "empty" : "too long",
      },
    };
  }

  const text = validated.text;
  const fields = {
    appId: input.app.id,
    reviewId: input.review.reviewId,
    userId: input.userId,
  };
  if (input.dryRun) {
    log("reply_dry_run", fields);
    return { ok: true, outcome: "dry_run", review: input.review, text };
  }

  const duplicate =
    input.review.repliedVia === "bot" && input.review.replyText === text;
  const posted = await input.source.reply(
    input.app,
    input.review.reviewId,
    text,
    input.budget,
  );
  if (!posted.ok) {
    log("reply_failed", {
      appId: input.app.id,
      reviewId: input.review.reviewId,
      kind: posted.failure.kind,
    });
    return posted;
  }

  const nowSeconds = Math.floor(input.nowMs / 1000);
  await writeBotReply(input.db, {
    id: input.review.id,
    text,
    userId: input.userId,
    nowSeconds,
  });
  log(duplicate ? "reply_duplicate" : "reply_published", fields);
  return {
    ok: true,
    outcome: duplicate ? "duplicate" : "published",
    review: {
      ...input.review,
      replyText: text,
      replyModifiedAt: nowSeconds,
      repliedVia: "bot",
      repliedBy: input.userId,
      repliedAt: nowSeconds,
    },
    text,
  };
}
