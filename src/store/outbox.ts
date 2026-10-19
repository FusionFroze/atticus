export type OutboxRow = {
  id: number;
  kind: string;
  reviewPk: number | null;
  payload: string;
  status: string;
  sortKey: number;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
};

type OutboxRecord = {
  id: number;
  kind: string;
  review_pk: number | null;
  payload: string;
  status: string;
  sort_key: number;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
};

// 30 days. Sent rows age by sent_at. Failed rows have no sent_at, so they age by created_at.
const OUTBOX_KEEP_SECONDS = 30 * 24 * 60 * 60;

// A read. The lease and the Discord nonce are the locks; this does not change status.
// kinds, when passed, leaves deferred rows (warning, recovered, digest) unclaimed.
export async function claimPending(
  db: D1Database,
  nowSeconds: number,
  limit: number,
  kinds?: readonly string[],
): Promise<OutboxRow[]> {
  if (kinds !== undefined && kinds.length === 0) return [];
  const kindFilter =
    kinds === undefined
      ? ""
      : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
  const rows = await db
    .prepare(
      `SELECT id, kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
       FROM outbox
       WHERE status = 'pending' AND next_attempt_at <= ?${kindFilter}
       ORDER BY sort_key, id
       LIMIT ?`,
    )
    .bind(nowSeconds, ...(kinds ?? []), limit)
    .all<OutboxRecord>();
  return rows.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    reviewPk: row.review_pk,
    payload: row.payload,
    status: row.status,
    sortKey: row.sort_key,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  }));
}

// Sets sent and, when reviewPk is set, inserts the message and clears the previous
// latest one. A connected row has no reviewPk and only updates the outbox.
export async function markOutboxSent(
  db: D1Database,
  input: {
    outboxId: number;
    reviewPk: number | null;
    channelId: string;
    messageId: string;
    version: number;
    nowSeconds: number;
  },
): Promise<void> {
  const sent = db
    .prepare("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?")
    .bind(input.nowSeconds, input.outboxId);
  if (input.reviewPk === null) {
    await sent.run();
    return;
  }
  await db.batch([
    sent,
    db
      .prepare(
        "UPDATE messages SET is_latest = 0 WHERE review_pk = ? AND is_latest = 1",
      )
      .bind(input.reviewPk),
    db
      .prepare(
        `INSERT INTO messages (
           review_pk, version, channel_id, message_id, is_latest, created_at
         ) VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        input.reviewPk,
        input.version,
        input.channelId,
        input.messageId,
        input.nowSeconds,
      ),
  ]);
}

// Records the caller's next attempt. Backoff durations belong to the sender.
export async function markOutboxRetry(
  db: D1Database,
  outboxId: number,
  nextAttemptAt: number,
  lastError: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE outbox
       SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
       WHERE id = ?`,
    )
    .bind(nextAttemptAt, lastError, outboxId)
    .run();
}

export async function markOutboxFailed(
  db: D1Database,
  outboxId: number,
  lastError: string,
): Promise<void> {
  await db
    .prepare("UPDATE outbox SET status = 'failed', last_error = ? WHERE id = ?")
    .bind(lastError, outboxId)
    .run();
}

// Pending rows stay. A row is removed only once it is older than 30 days.
export async function pruneOutbox(
  db: D1Database,
  nowSeconds: number,
): Promise<number> {
  const cutoff = nowSeconds - OUTBOX_KEEP_SECONDS;
  const result = await db
    .prepare(
      `DELETE FROM outbox
       WHERE (status = 'sent' AND sent_at < ?)
          OR (status = 'failed' AND created_at < ?)`,
    )
    .bind(cutoff, cutoff)
    .run();
  return result.meta.changes;
}
