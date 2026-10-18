import type { AppConfig } from "../config/types";
import type { Review } from "../core/review";
import { insertReviewStatement, outboxForLastInsert } from "./review-row";

// One batch: stored reviews oldest first, review_new only for post, then connected
// (sort_key 0, so it is claimed first), then app_seen. The payload has no review text.
export async function writeFirstRun(
  db: D1Database,
  input: {
    app: AppConfig;
    reviews: readonly Review[];
    backfill: "post" | "silent";
    nowSeconds: number;
  },
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const review of oldestFirst(input.reviews)) {
    statements.push(insertReviewStatement(db, review, input.nowSeconds));
    if (input.backfill === "post") {
      statements.push(
        outboxForLastInsert(
          db,
          "review_new",
          review.modifiedAt,
          input.nowSeconds,
        ),
      );
    }
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO outbox (
           kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
         ) VALUES ('connected', NULL, ?, 'pending', 0, 0, 0, ?)`,
      )
      .bind(connectedPayload(input), input.nowSeconds),
    db
      .prepare("INSERT INTO state (key, value, updated_at) VALUES (?, '1', ?)")
      .bind(appSeenKey(input.app), input.nowSeconds),
  );
  await db.batch(statements);
}

function oldestFirst(reviews: readonly Review[]): Review[] {
  return [...reviews].sort(
    (left, right) =>
      left.modifiedAt - right.modifiedAt ||
      left.reviewId.localeCompare(right.reviewId),
  );
}

function connectedPayload(input: {
  app: AppConfig;
  reviews: readonly Review[];
  backfill: "post" | "silent";
}): string {
  return JSON.stringify({
    store: input.app.store,
    appId: input.app.id,
    appName: input.app.name,
    count: input.reviews.length,
    backfill: input.backfill,
  });
}

export function appSeenKey(app: AppConfig): string {
  return `app_seen:${app.store}:${app.id}`;
}
