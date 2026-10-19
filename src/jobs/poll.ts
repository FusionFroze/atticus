import type { AppConfig, Config } from "../config/types";
import { diffReview } from "../core/diff";
import type { Review, StoredReview } from "../core/review";
import type { Budget } from "../lib/budget";
import { type LogValue, log } from "../lib/log";
import type { ReviewSource, SourceFailure } from "../sources/types";
import {
  appSeenKey,
  finishRun,
  insertReviewWithOutbox,
  type ReviewUpdateOutcome,
  readReviews,
  releaseLease,
  startRun,
  updateReview,
  writeFirstRun,
} from "../store";
import { enqueueDueDigests } from "./digest";
import { noteListFailure, noteListSuccess, noteRemovedApps } from "./health";
import { createRunState, type RunState } from "./run-state";

type RunCounts = {
  apps: number;
  failed: number;
  reviewNew: number;
  reviewEdited: number;
  replyExternal: number;
  replyRemoved: number;
};

type PollInput = {
  db: D1Database;
  config: Config;
  source: ReviewSource;
  budget: Budget;
  nowMs: number;
  afterApps?: (state: RunState) => Promise<{ sent: number }>;
};

// Under the lease: list, diff, write, then the sender. First successful list sets
// app_seen, even when truncated. A failed list does not. The lease and the state
// rows come in one batch at the start; last_poll_at, the prune and the release go
// in one batch at the end.
export async function poll(input: PollInput): Promise<void> {
  const nowSeconds = Math.floor(input.nowMs / 1000);
  const started = await startRun(input.db, nowSeconds, crypto.randomUUID());
  if (started === null) {
    log("run_skipped_locked");
    return;
  }
  const state = createRunState(started.state);

  const counts: RunCounts = {
    apps: 0,
    failed: 0,
    reviewNew: 0,
    reviewEdited: 0,
    replyExternal: 0,
    replyRemoved: 0,
  };
  let finished = false;
  try {
    log("run_start");
    await noteRemovedApps(input.db, state, input.config.apps, nowSeconds);
    for (const app of input.config.apps) {
      const stop = await pollApp(input, state, app, nowSeconds, counts);
      if (stop) break;
    }
    await enqueueDueDigests({
      db: input.db,
      config: input.config,
      state,
      nowMs: input.nowMs,
    });
    const sent =
      input.afterApps === undefined ? 0 : (await input.afterApps(state)).sent;
    await finishRun(input.db, { lease: started.lease, nowSeconds });
    finished = true;
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
    if (!finished) await releaseLease(input.db, started.lease);
  }
}

// True means the budget is spent and later apps wait for the next run.
async function pollApp(
  input: PollInput,
  state: RunState,
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
    await noteListFailure(input.db, state, app, listed.failure, nowSeconds);
    return false;
  }

  await noteListSuccess(input.db, state, app.id, nowSeconds);
  if (listed.truncated) log("poll_truncated", { appId: app.id });
  log("poll_app", {
    appId: app.id,
    count: listed.reviews.length,
    reviewIds: listed.reviews.map((review) => review.reviewId),
  });
  counts.apps += 1;

  if (state.get(appSeenKey(app)) === null) {
    await writeFirstRun(input.db, {
      app,
      reviews: listed.reviews,
      backfill: input.config.backfill,
      nowSeconds,
    });
    state.set(appSeenKey(app), "1");
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
