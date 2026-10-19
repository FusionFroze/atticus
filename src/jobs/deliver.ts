import type { Config } from "../config/types";
import type { StoredReview } from "../core/review";
import type {
  Notifier,
  ReviewMessageInput,
  SendResult,
} from "../notifiers/types";
import { type OutboxRow, readLatestMessage, readReview } from "../store";

// Reads the row at send time. A deleted Discord message is posted again, with
// no reply reference, and that post becomes the latest message.
export async function postStoredReview(
  db: D1Database,
  notifier: Notifier,
  config: Config,
  row: OutboxRow,
): Promise<
  | { ok: false; reason: "missing" }
  | { ok: true; result: SendResult; modifiedAt: number }
> {
  if (row.reviewPk === null) return { ok: false, reason: "missing" };
  const review = await readReview(db, row.reviewPk);
  if (review === null) return { ok: false, reason: "missing" };
  const result = await postOrEdit(
    db,
    notifier,
    row,
    reviewMessage(config, review, row.kind),
  );
  return { ok: true, result, modifiedAt: review.modifiedAt };
}

async function postOrEdit(
  db: D1Database,
  notifier: Notifier,
  row: OutboxRow,
  message: ReviewMessageInput,
): Promise<SendResult> {
  const latest =
    row.reviewPk === null ? null : await readLatestMessage(db, row.reviewPk);
  if (row.kind === "review_edited") {
    return notifier.postReview(message, `o${row.id}`, latest);
  }
  if (row.kind === "message_update" && latest !== null) {
    const edited = await notifier.updateReview(latest, message);
    if (edited.ok || edited.failure.kind !== "gone") return edited;
    return notifier.postReview(message, `o${row.id}`);
  }
  return notifier.postReview(message, `o${row.id}`);
}

function reviewMessage(
  config: Config,
  review: StoredReview,
  kind: string,
): ReviewMessageInput {
  const app = config.apps.find(
    (item) => item.store === review.store && item.id === review.appId,
  );
  return {
    review,
    appName: app?.name ?? review.appId,
    consoleUrl: app?.consoleUrl ?? null,
    mention: mentionFor(config, kind, review.rating),
    showUpdated:
      kind === "review_edited" ||
      (kind === "message_update" && review.previousRating !== null),
  };
}

function mentionFor(
  config: Config,
  kind: string,
  rating: number,
): ReviewMessageInput["mention"] {
  if (config.pingOnLowRating === null) return null;
  if (kind !== "review_new" && kind !== "review_edited") return null;
  if (rating > 2) return null;
  return config.pingOnLowRating;
}
