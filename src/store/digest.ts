import type { DigestRow } from "../core/digest";
import { WEEK_SECONDS } from "../core/digest";
import type { Store } from "../core/review";

export const DIGEST_LAST_KEY = "digest_last";
export const DISCORD_GUILD_KEY = "discord_guild";

export type DigestReviewRow = DigestRow & {
  message: { channelId: string; messageId: string } | null;
};

type DigestSqlRow = {
  id: number;
  rating: number;
  title: string | null;
  app_version_name: string | null;
  modified_at: number;
  first_seen_at: number;
  replied_via: string | null;
  replied_at: number | null;
  channel_id: string | null;
  message_id: string | null;
};

// One read for both weeks. It does not select author, body, or reply text.
export async function readDigestRows(
  db: D1Database,
  app: { store: Store; id: string },
  windowEnd: number,
): Promise<DigestReviewRow[]> {
  const thisStart = windowEnd - WEEK_SECONDS;
  const previousStart = windowEnd - 2 * WEEK_SECONDS;
  const rows = await db
    .prepare(
      `SELECT
         r.id, r.rating, r.title, r.app_version_name, r.modified_at, r.first_seen_at,
         r.replied_via, r.replied_at, m.channel_id, m.message_id
       FROM reviews r
       LEFT JOIN messages m ON m.id = (
         SELECT id FROM messages
         WHERE review_pk = r.id AND is_latest = 1
         ORDER BY id DESC
         LIMIT 1
       )
       WHERE r.store = ? AND r.app_id = ?
         AND (
           (r.first_seen_at >= ? AND r.first_seen_at < ?)
           OR (
             r.first_seen_at < ?
             AND r.modified_at >= ?
             AND r.modified_at < ?
           )
         )`,
    )
    .bind(
      app.store,
      app.id,
      previousStart,
      windowEnd,
      thisStart,
      thisStart,
      windowEnd,
    )
    .all<DigestSqlRow>();
  const mapped: DigestReviewRow[] = [];
  for (const row of rows.results) {
    const rating = asRating(row.rating);
    if (rating === null) continue;
    mapped.push({
      id: row.id,
      rating,
      title: row.title,
      appVersionName: row.app_version_name,
      modifiedAt: row.modified_at,
      firstSeenAt: row.first_seen_at,
      repliedVia: asReply(row.replied_via),
      repliedAt: row.replied_at,
      message: messageOf(row),
    });
  }
  return mapped;
}

// The outbox rows and digest_last land together, so a crash cannot post the week twice.
export async function enqueueDigestBatch(
  db: D1Database,
  input: {
    rows: { payload: string; sortKey: number }[];
    localDate: string;
    nowSeconds: number;
  },
): Promise<void> {
  const inserts = input.rows.map((row) =>
    db
      .prepare(
        `INSERT INTO outbox (
           kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
         ) VALUES ('digest', NULL, ?, 'pending', ?, 0, 0, ?)`,
      )
      .bind(row.payload, row.sortKey, input.nowSeconds),
  );
  const state = db
    .prepare(
      `INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
    )
    .bind(DIGEST_LAST_KEY, input.localDate, input.nowSeconds);
  await db.batch([...inserts, state]);
}

function asRating(value: number): DigestRow["rating"] | null {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) {
    return value;
  }
  return null;
}

function asReply(value: string | null): DigestRow["repliedVia"] {
  if (value === "bot" || value === "external") return value;
  return null;
}

function messageOf(
  row: DigestSqlRow,
): { channelId: string; messageId: string } | null {
  if (row.channel_id === null || row.channel_id === "") return null;
  if (row.message_id === null || row.message_id === "") return null;
  return { channelId: row.channel_id, messageId: row.message_id };
}
