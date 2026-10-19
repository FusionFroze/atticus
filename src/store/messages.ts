import type { StoredReview } from "../core/review";
import { mapReview, REVIEW_COLUMNS, type ReviewRow } from "./review-row";

const JOINED_COLUMNS = REVIEW_COLUMNS.split(",")
  .map((column) => `r.${column.trim()}`)
  .join(", ");

// The review and its latest message in one read, taken just before the send so
// the message shows the row as it is now.
export async function readReviewForSend(
  db: D1Database,
  reviewPk: number,
): Promise<{
  review: StoredReview;
  latest: { channelId: string; messageId: string } | null;
} | null> {
  const row = await db
    .prepare(
      `SELECT ${JOINED_COLUMNS},
         m.channel_id AS latest_channel_id, m.message_id AS latest_message_id
       FROM reviews r
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages
         WHERE review_pk = r.id AND is_latest = 1
         ORDER BY id DESC
         LIMIT 1
       )
       WHERE r.id = ?`,
    )
    .bind(reviewPk)
    .first<
      ReviewRow & {
        latest_channel_id: string | null;
        latest_message_id: string | null;
      }
    >();
  if (row === null) return null;
  const latest =
    row.latest_channel_id === null || row.latest_message_id === null
      ? null
      : { channelId: row.latest_channel_id, messageId: row.latest_message_id };
  return { review: mapReview(row), latest };
}
