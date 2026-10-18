import type { Review, StoredReview } from "./review";

export type DiffOutcome =
  | { kind: "new" }
  | { kind: "edited" }
  | { kind: "own_reply_seen" }
  | { kind: "replied_elsewhere" }
  | { kind: "reply_removed" }
  | { kind: "thumbs_changed" }
  | { kind: "unchanged" };

// A newer modifiedAt is an edit, even when the reply changed too. An older one is
// left alone. Reply text is compared exactly. own_reply_seen requires the bot's
// text to match and Play's reply timestamp to differ, so a later thumbs change
// is not hidden behind it.
export function diffReview(
  stored: StoredReview | null,
  fetched: Review,
): DiffOutcome {
  if (stored === null) return { kind: "new" };
  if (fetched.modifiedAt > stored.modifiedAt) return { kind: "edited" };
  if (fetched.modifiedAt < stored.modifiedAt) return { kind: "unchanged" };

  const fetchedReply = fetched.developerReply?.text ?? null;
  if (stored.replyText !== null && fetched.developerReply === null) {
    return { kind: "reply_removed" };
  }
  if (stored.replyText !== fetchedReply) return { kind: "replied_elsewhere" };
  if (
    stored.repliedVia === "bot" &&
    fetched.developerReply !== null &&
    fetched.developerReply.modifiedAt !== stored.replyModifiedAt
  ) {
    return { kind: "own_reply_seen" };
  }
  if (stored.thumbsUp !== fetched.thumbsUp) return { kind: "thumbs_changed" };
  return { kind: "unchanged" };
}
