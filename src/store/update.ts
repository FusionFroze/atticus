import type { Review, StoredReview } from "../core/review";

export type ReviewUpdateOutcome =
  | "edited"
  | "own_reply_seen"
  | "replied_elsewhere"
  | "reply_removed"
  | "thumbs_changed";

// A pending review_new or review_edited absorbs another edit. A pending review_new or
// message_update absorbs another message_update. The review row is still updated.
export async function updateReview(
  db: D1Database,
  input: {
    stored: StoredReview;
    review: Review;
    nowSeconds: number;
    outcome: ReviewUpdateOutcome;
  },
): Promise<void> {
  switch (input.outcome) {
    case "edited":
      await updateEdited(db, input);
      return;
    case "own_reply_seen":
      await updateOwnReply(db, input);
      return;
    case "replied_elsewhere":
      await updateElsewhere(db, input);
      return;
    case "reply_removed":
      await updateReplyRemoved(db, input);
      return;
    case "thumbs_changed":
      await db
        .prepare("UPDATE reviews SET thumbs_up = ? WHERE id = ?")
        .bind(input.review.thumbsUp, input.stored.id)
        .run();
      return;
  }
}

async function updateEdited(
  db: D1Database,
  input: {
    stored: StoredReview;
    review: Review;
    nowSeconds: number;
  },
): Promise<void> {
  const reply = editedReply(input.stored, input.review);
  const update = db
    .prepare(
      `UPDATE reviews SET
         rating = ?, previous_rating = ?, title = ?, body = ?, original_body = ?,
         language = ?, author = ?, app_version_name = ?, app_version_code = ?,
         os_version = ?, device = ?, thumbs_up = ?, modified_at = ?,
         reply_text = ?, reply_modified_at = ?, replied_via = ?, replied_by = ?, replied_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.review.rating,
      input.stored.rating,
      input.review.title,
      input.review.body,
      input.review.originalBody,
      input.review.language,
      input.review.author,
      input.review.appVersionName,
      input.review.appVersionCode,
      input.review.osVersion,
      input.review.device,
      input.review.thumbsUp,
      input.review.modifiedAt,
      reply.text,
      reply.modifiedAt,
      reply.via,
      reply.by,
      reply.at,
      input.stored.id,
    );
  const absorbed = await hasPending(db, input.stored.id, [
    "review_new",
    "review_edited",
  ]);
  await applyWrite(
    db,
    update,
    absorbed
      ? null
      : enqueueExisting(
          db,
          "review_edited",
          input.stored.id,
          input.review.modifiedAt,
          input.nowSeconds,
        ),
  );
}

// Same reply text on a bot reply keeps who sent it. Different text is external.
// No Play reply clears the reply columns.
function editedReply(
  stored: StoredReview,
  review: Review,
): {
  text: string | null;
  modifiedAt: number | null;
  via: StoredReview["repliedVia"];
  by: string | null;
  at: number | null;
} {
  const play = review.developerReply;
  if (play === null) {
    return { text: null, modifiedAt: null, via: null, by: null, at: null };
  }
  if (play.text === stored.replyText && stored.repliedVia === "bot") {
    return {
      text: play.text,
      modifiedAt: play.modifiedAt,
      via: "bot",
      by: stored.repliedBy,
      at: stored.repliedAt,
    };
  }
  if (play.text === stored.replyText) {
    return {
      text: play.text,
      modifiedAt: play.modifiedAt,
      via: stored.repliedVia,
      by: stored.repliedBy,
      at: stored.repliedAt,
    };
  }
  return {
    text: play.text,
    modifiedAt: play.modifiedAt,
    via: "external",
    by: null,
    at: null,
  };
}

async function updateOwnReply(
  db: D1Database,
  input: { stored: StoredReview; review: Review },
): Promise<void> {
  const modifiedAt = input.review.developerReply?.modifiedAt;
  if (modifiedAt === undefined) {
    throw new Error("own_reply_seen requires a developer reply");
  }
  await db
    .prepare("UPDATE reviews SET reply_modified_at = ? WHERE id = ?")
    .bind(modifiedAt, input.stored.id)
    .run();
}

async function updateElsewhere(
  db: D1Database,
  input: {
    stored: StoredReview;
    review: Review;
    nowSeconds: number;
  },
): Promise<void> {
  const play = input.review.developerReply;
  if (play === null) {
    throw new Error("replied_elsewhere requires a developer reply");
  }
  const update = db
    .prepare(
      `UPDATE reviews SET
         reply_text = ?, reply_modified_at = ?, replied_via = 'external',
         replied_by = NULL, replied_at = NULL
       WHERE id = ?`,
    )
    .bind(play.text, play.modifiedAt, input.stored.id);
  await writeReplyUpdate(db, input, update);
}

async function updateReplyRemoved(
  db: D1Database,
  input: {
    stored: StoredReview;
    review: Review;
    nowSeconds: number;
  },
): Promise<void> {
  const update = db
    .prepare(
      `UPDATE reviews SET
         reply_text = NULL, reply_modified_at = NULL, replied_via = NULL,
         replied_by = NULL, replied_at = NULL
       WHERE id = ?`,
    )
    .bind(input.stored.id);
  await writeReplyUpdate(db, input, update);
}

async function writeReplyUpdate(
  db: D1Database,
  input: { stored: StoredReview; review: Review; nowSeconds: number },
  update: D1PreparedStatement,
): Promise<void> {
  const absorbed = await hasPending(db, input.stored.id, [
    "message_update",
    "review_new",
  ]);
  await applyWrite(
    db,
    update,
    absorbed
      ? null
      : enqueueExisting(
          db,
          "message_update",
          input.stored.id,
          input.review.modifiedAt,
          input.nowSeconds,
        ),
  );
}

function enqueueExisting(
  db: D1Database,
  kind: "review_edited" | "message_update",
  reviewPk: number,
  sortKey: number,
  nowSeconds: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (
         kind, review_pk, payload, status, sort_key, attempts, next_attempt_at, created_at
       ) VALUES (?, ?, '{}', 'pending', ?, 0, 0, ?)`,
    )
    .bind(kind, reviewPk, sortKey, nowSeconds);
}

async function applyWrite(
  db: D1Database,
  update: D1PreparedStatement,
  outbox: D1PreparedStatement | null,
): Promise<void> {
  if (outbox === null) {
    await update.run();
    return;
  }
  await db.batch([update, outbox]);
}

async function hasPending(
  db: D1Database,
  reviewPk: number,
  kinds: readonly string[],
): Promise<boolean> {
  const marks = kinds.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT 1 AS found FROM outbox
       WHERE review_pk = ? AND status = 'pending' AND kind IN (${marks})
       LIMIT 1`,
    )
    .bind(reviewPk, ...kinds)
    .first<{ found: number }>();
  return row !== null;
}
