// A new reply notifies the reviewer when none is stored, or every stored reply
// timestamp is older than this review version. Missing timestamps stay "edit"
// so the hint does not promise a notification.
export function replyWouldNotify(review: {
  replyText: string | null;
  replyModifiedAt: number | null;
  repliedAt: number | null;
  modifiedAt: number;
}): boolean {
  if (review.replyText === null) return true;
  const known = [review.replyModifiedAt, review.repliedAt].filter(
    (value): value is number => value !== null,
  );
  if (known.length === 0) return false;
  return known.every((value) => value < review.modifiedAt);
}
