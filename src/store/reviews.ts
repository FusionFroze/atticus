import type { Review, StoredReview } from "../core/review";
import {
  idFromInsert,
  insertReviewStatement,
  mapReview,
  outboxForLastInsert,
  REVIEW_COLUMNS,
  type ReviewRow,
} from "./review-row";

// A D1 statement binds at most 100 parameters. store and app_id take two of them.
const READ_ID_CHUNK = 98;

export async function readReviews(
  db: D1Database,
  store: Review["store"],
  appId: string,
  reviewIds: readonly string[],
): Promise<Map<string, StoredReview>> {
  const found = new Map<string, StoredReview>();
  for (let start = 0; start < reviewIds.length; start += READ_ID_CHUNK) {
    const ids = reviewIds.slice(start, start + READ_ID_CHUNK);
    const marks = ids.map(() => "?").join(", ");
    const rows = await db
      .prepare(
        `SELECT ${REVIEW_COLUMNS} FROM reviews
         WHERE store = ? AND app_id = ? AND review_id IN (${marks})`,
      )
      .bind(store, appId, ...ids)
      .all<ReviewRow>();
    for (const row of rows.results) {
      const stored = mapReview(row);
      found.set(stored.reviewId, stored);
    }
  }
  return found;
}

export async function writeBotReply(
  db: D1Database,
  input: { id: number; text: string; userId: string; nowSeconds: number },
): Promise<void> {
  await db
    .prepare(
      `UPDATE reviews SET
         reply_text = ?, reply_modified_at = ?, replied_via = 'bot',
         replied_by = ?, replied_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.text,
      input.nowSeconds,
      input.userId,
      input.nowSeconds,
      input.id,
    )
    .run();
}

export async function readReview(
  db: D1Database,
  id: number,
): Promise<StoredReview | null> {
  const row = await db
    .prepare(`SELECT ${REVIEW_COLUMNS} FROM reviews WHERE id = ?`)
    .bind(id)
    .first<ReviewRow>();
  if (row === null) return null;
  return mapReview(row);
}

// The review insert and its outbox row are one batch. last_insert_rowid() reads the
// review id from that same transaction. enqueue false stores the row only.
export async function insertReviewWithOutbox(
  db: D1Database,
  input: { review: Review; nowSeconds: number; enqueue: boolean },
): Promise<number> {
  const insert = insertReviewStatement(db, input.review, input.nowSeconds);
  if (!input.enqueue) return idFromInsert(await insert.run<{ id: number }>());

  const outbox = outboxForLastInsert(
    db,
    "review_new",
    input.review.modifiedAt,
    input.nowSeconds,
  );
  const [inserted] = await db.batch<{ id: number }>([insert, outbox]);
  if (inserted === undefined) throw new Error("insert did not return an id");
  return idFromInsert(inserted);
}
