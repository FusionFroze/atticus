import type { Review, StoredReview } from "../core/review";

export const REVIEW_COLUMNS = `id, store, app_id, review_id, rating, previous_rating, title, body,
  original_body, language, author, app_version_name, app_version_code, os_version, device,
  thumbs_up, modified_at, first_seen_at, reply_text, reply_modified_at, replied_via,
  replied_by, replied_at`;

export type ReviewRow = {
  id: number;
  store: string;
  app_id: string;
  review_id: string;
  rating: number;
  previous_rating: number | null;
  title: string | null;
  body: string;
  original_body: string | null;
  language: string | null;
  author: string | null;
  app_version_name: string | null;
  app_version_code: number | null;
  os_version: string | null;
  device: string | null;
  thumbs_up: number;
  modified_at: number;
  first_seen_at: number;
  reply_text: string | null;
  reply_modified_at: number | null;
  replied_via: string | null;
  replied_by: string | null;
  replied_at: number | null;
};

export function insertReviewStatement(
  db: D1Database,
  review: Review,
  nowSeconds: number,
): D1PreparedStatement {
  const reply = insertedReply(review);
  return db
    .prepare(
      `INSERT INTO reviews (
         store, app_id, review_id, rating, previous_rating,
         title, body, original_body, language, author,
         app_version_name, app_version_code, os_version, device, thumbs_up,
         modified_at, first_seen_at,
         reply_text, reply_modified_at, replied_via, replied_by, replied_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
       RETURNING id`,
    )
    .bind(
      review.store,
      review.appId,
      review.reviewId,
      review.rating,
      review.title,
      review.body,
      review.originalBody,
      review.language,
      review.author,
      review.appVersionName,
      review.appVersionCode,
      review.osVersion,
      review.device,
      review.thumbsUp,
      review.modifiedAt,
      nowSeconds,
      reply.text,
      reply.modifiedAt,
      reply.via,
    );
}

// A reply already present was not published by Atticus, so it is external.
function insertedReply(review: Review): {
  text: string | null;
  modifiedAt: number | null;
  via: "external" | null;
} {
  if (review.developerReply === null) {
    return { text: null, modifiedAt: null, via: null };
  }
  return {
    text: review.developerReply.text,
    modifiedAt: review.developerReply.modifiedAt,
    via: "external",
  };
}

export function outboxForLastInsert(
  db: D1Database,
  kind: "review_new",
  sortKey: number,
  nowSeconds: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (
         kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
       ) VALUES (?, last_insert_rowid(), '{}', 'pending', ?, 0, 0, ?)`,
    )
    .bind(kind, sortKey, nowSeconds);
}

export function idFromInsert(result: D1Result<{ id: number }>): number {
  const row = result.results[0];
  if (row !== undefined && typeof row.id === "number") return row.id;
  if (result.meta.last_row_id > 0) return result.meta.last_row_id;
  throw new Error("insert did not return an id");
}

export function mapReview(row: ReviewRow): StoredReview {
  return {
    id: row.id,
    store: storeOf(row.store),
    appId: row.app_id,
    reviewId: row.review_id,
    rating: ratingOf(row.rating),
    previousRating:
      row.previous_rating === null ? null : ratingOf(row.previous_rating),
    title: row.title,
    body: row.body,
    originalBody: row.original_body,
    language: row.language,
    author: row.author,
    appVersionName: row.app_version_name,
    appVersionCode: row.app_version_code,
    osVersion: row.os_version,
    device: row.device,
    thumbsUp: row.thumbs_up,
    modifiedAt: row.modified_at,
    firstSeenAt: row.first_seen_at,
    replyText: row.reply_text,
    replyModifiedAt: row.reply_modified_at,
    repliedVia: repliedViaOf(row.replied_via),
    repliedBy: row.replied_by,
    repliedAt: row.replied_at,
  };
}

function storeOf(value: string): Review["store"] {
  if (value === "play") return value;
  throw new Error("stored review has an invalid store");
}

function ratingOf(value: number): Review["rating"] {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) {
    return value;
  }
  throw new Error("stored review has an invalid rating");
}

function repliedViaOf(value: string | null): StoredReview["repliedVia"] {
  if (value === null) return null;
  if (value === "bot" || value === "external") return value;
  throw new Error("stored review has an invalid replied_via");
}
