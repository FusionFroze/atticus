export async function readLatestMessage(
  db: D1Database,
  reviewPk: number,
): Promise<{ channelId: string; messageId: string } | null> {
  const row = await db
    .prepare(
      `SELECT channel_id, message_id FROM messages
       WHERE review_pk = ? AND is_latest = 1
       ORDER BY id DESC
       LIMIT 1`,
    )
    .bind(reviewPk)
    .first<{ channel_id: string; message_id: string }>();
  if (row === null) return null;
  return { channelId: row.channel_id, messageId: row.message_id };
}
