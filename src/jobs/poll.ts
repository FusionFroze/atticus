import type { AppConfig, Config } from "../config/types";
import { diffReview } from "../core/diff";
import type { Review, StoredReview } from "../core/review";
import type { Budget } from "../lib/budget";
import { type LogValue, log } from "../lib/log";
import type { ReviewSource, SourceFailure } from "../sources/types";
import {
  appSeenKey,
  getState,
  insertReviewWithOutbox,
  pruneOutbox,
  type ReviewUpdateOutcome,
  readReviews,
  releaseLease,
  setState,
  takeLease,
  updateReview,
  writeFirstRun,
} from "../store";

const LAST_POLL_AT = "last_poll_at";

type RunCounts = {
  apps: number;
  failed: number;
  reviewNew: number;
  reviewEdited: number;
  replyExternal: number;
  replyRemoved: number;
};

// Under the lease: list, diff, write, then the sender. First successful list sets
// app_seen, even when truncated. A failed list does not. Warnings wait for v1-5;
// this run only logs.
export async function poll(input: {
  db: D1Database;
  config: Config;
  source: ReviewSource;
  budget: Budget;
  nowMs: number;
  afterApps?: () => Promise<{ sent: number }>;
}): Promise<void> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const holder = crypto.randomUUID();
  const taken = await takeLease(input.db, nowSeconds, holder);
  if (!taken) {
    log("run_skipped_locked");
    return;
  }

  const counts: RunCounts = {
    apps: 0,
    failed: 0,
    reviewNew: 0,
    reviewEdited: 0,
    replyExternal: 0,
    replyRemoved: 0,
  };
  try {
    log("run_start");
    for (const app of input.config.apps) {
      const stop = await pollApp(input, app, nowSeconds, counts);
      if (stop) break;
    }
    const sent =
      input.afterApps === undefined ? 0 : (await input.afterApps()).sent;
    await setState(input.db, LAST_POLL_AT, String(nowSeconds), nowSeconds);
    await pruneOutbox(input.db, nowSeconds);
    log("run_end", {
      durationMs: Date.now() - input.nowMs,
      apps: counts.apps,
      failed: counts.failed,
      reviewNew: counts.reviewNew,
      reviewEdited: counts.reviewEdited,
      replyExternal: counts.replyExternal,
      replyRemoved: counts.replyRemoved,
      sent,
    });
  } finally {
    await releaseLease(input.db, holder);
  }
}

// True means the budget is spent and later apps wait for the next run.
async function pollApp(
  input: {
    db: D1Database;
    config: Config;
    source: ReviewSource;
    budget: Budget;
  },
  app: AppConfig,
  nowSeconds: number,
  counts: RunCounts,
): Promise<boolean> {
  const listed = await input.source.listRecent(app, input.budget);
  if (!listed.ok) {
    counts.failed += 1;
    log("poll_failed", { appId: app.id, ...failureFields(listed.failure) });
    if (listed.failure.kind === "budget") {
      log("budget_exhausted");
      return true;
    }
    return false;
  }

  if (listed.truncated) log("poll_truncated", { appId: app.id });
  log("poll_app", {
    appId: app.id,
    count: listed.reviews.length,
    reviewIds: listed.reviews.map((review) => review.reviewId),
  });
  counts.apps += 1;

  const seen = await getState(input.db, appSeenKey(app));
  if (seen === null) {
    await writeFirstRun(input.db, {
      app,
      reviews: listed.reviews,
      backfill: input.config.backfill,
      nowSeconds,
    });
    counts.reviewNew += listed.reviews.length;
    for (const review of oldestFirst(listed.reviews)) {
      log("review_new", { appId: review.appId, reviewId: review.reviewId });
    }
    return false;
  }

  const stored = await readReviews(
    input.db,
    app.store,
    app.id,
    listed.reviews.map((review) => review.reviewId),
  );
  for (const review of oldestFirst(listed.reviews)) {
    await applyReview(
      input.db,
      stored.get(review.reviewId) ?? null,
      review,
      nowSeconds,
      counts,
    );
  }
  return false;
}

async function applyReview(
  db: D1Database,
  stored: StoredReview | null,
  review: Review,
  nowSeconds: number,
  counts: RunCounts,
): Promise<void> {
  const outcome = diffReview(stored, review);
  switch (outcome.kind) {
    case "new":
      await insertReviewWithOutbox(db, {
        review,
        nowSeconds,
        enqueue: true,
      });
      counts.reviewNew += 1;
      log("review_new", { appId: review.appId, reviewId: review.reviewId });
      return;
    case "unchanged":
      return;
    case "edited":
    case "own_reply_seen":
    case "replied_elsewhere":
    case "reply_removed":
    case "thumbs_changed":
      if (stored === null) {
        throw new Error("diff outcome requires a stored review");
      }
      await updateReview(db, {
        stored,
        review,
        nowSeconds,
        outcome: outcome.kind,
      });
      noteUpdate(outcome.kind, review, counts);
      return;
  }
}

function noteUpdate(
  kind: ReviewUpdateOutcome,
  review: Review,
  counts: RunCounts,
): void {
  if (kind === "edited") {
    counts.reviewEdited += 1;
    log("review_edited", { appId: review.appId, reviewId: review.reviewId });
    return;
  }
  if (kind === "replied_elsewhere") {
    counts.replyExternal += 1;
    log("reply_external", { appId: review.appId, reviewId: review.reviewId });
    return;
  }
  if (kind === "reply_removed") {
    counts.replyRemoved += 1;
    log("reply_removed", { appId: review.appId, reviewId: review.reviewId });
  }
}

function oldestFirst(reviews: readonly Review[]): Review[] {
  return [...reviews].sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt ||
      left.reviewId.localeCompare(right.reviewId),
  );
}

function failureFields(failure: SourceFailure): Record<string, LogValue> {
  if (failure.kind === "unavailable") {
    return { kind: failure.kind, status: failure.status };
  }
  if (failure.kind === "invalid") {
    return { kind: failure.kind, detail: failure.detail };
  }
  return { kind: failure.kind };
}
