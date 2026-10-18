import { describe, expect, it } from "vitest";
import { diffReview } from "../src/core/diff";
import type { Review, StoredReview } from "../src/core/review";

const MODIFIED_AT = 1_700_000_000;

describe("diffReview", () => {
  it("returns new when nothing is stored", () => {
    expect(diffReview(null, fetched())).toEqual({ kind: "new" });
  });

  it("returns edited when modifiedAt is greater", () => {
    expect(
      diffReview(
        stored(),
        fetched({
          modifiedAt: MODIFIED_AT + 1,
          body: "Edited",
          thumbsUp: 9,
          developerReply: { text: "New reply", modifiedAt: 5 },
        }),
      ),
    ).toEqual({ kind: "edited" });
  });

  it("returns unchanged when modifiedAt is lower", () => {
    expect(
      diffReview(
        stored({ replyText: "Thanks", repliedVia: "bot" }),
        fetched({
          modifiedAt: MODIFIED_AT - 1,
          thumbsUp: 9,
          developerReply: null,
        }),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("returns own_reply_seen when the bot reply text matches and its timestamp moved", () => {
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
          repliedBy: "user-1",
        }),
        fetched({ developerReply: { text: "Thanks", modifiedAt: 20 } }),
      ),
    ).toEqual({ kind: "own_reply_seen" });
  });

  it("returns own_reply_seen before a thumbs change when the bot timestamp moved", () => {
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
          thumbsUp: 1,
        }),
        fetched({
          thumbsUp: 4,
          developerReply: { text: "Thanks", modifiedAt: 20 },
        }),
      ),
    ).toEqual({ kind: "own_reply_seen" });
  });

  it("returns replied_elsewhere when a reply appears", () => {
    expect(
      diffReview(
        stored(),
        fetched({ developerReply: { text: "From console", modifiedAt: 30 } }),
      ),
    ).toEqual({ kind: "replied_elsewhere" });
  });

  it("returns replied_elsewhere when the reply text changes", () => {
    expect(
      diffReview(
        stored({ replyText: "Thanks", repliedVia: "external" }),
        fetched({ developerReply: { text: "Thanks ", modifiedAt: 30 } }),
      ),
    ).toEqual({ kind: "replied_elsewhere" });
  });

  it("returns replied_elsewhere when the bot reply text is overwritten", () => {
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
          repliedBy: "user-1",
        }),
        fetched({ developerReply: { text: "Different", modifiedAt: 30 } }),
      ),
    ).toEqual({ kind: "replied_elsewhere" });
  });

  it("returns reply_removed when a stored reply is gone", () => {
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
        }),
        fetched({ developerReply: null }),
      ),
    ).toEqual({ kind: "reply_removed" });
  });

  it("returns thumbs_changed when the reply is unchanged and the count moved", () => {
    expect(
      diffReview(stored({ thumbsUp: 1 }), fetched({ thumbsUp: 2 })),
    ).toEqual({ kind: "thumbs_changed" });
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "external",
          thumbsUp: 1,
        }),
        fetched({
          thumbsUp: 2,
          developerReply: { text: "Thanks", modifiedAt: 10 },
        }),
      ),
    ).toEqual({ kind: "thumbs_changed" });
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
          thumbsUp: 1,
        }),
        fetched({
          thumbsUp: 2,
          developerReply: { text: "Thanks", modifiedAt: 10 },
        }),
      ),
    ).toEqual({ kind: "thumbs_changed" });
  });

  it("returns unchanged when the row matches", () => {
    expect(diffReview(stored(), fetched())).toEqual({ kind: "unchanged" });
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "bot",
          thumbsUp: 1,
        }),
        fetched({
          thumbsUp: 1,
          developerReply: { text: "Thanks", modifiedAt: 10 },
        }),
      ),
    ).toEqual({ kind: "unchanged" });
  });

  it("returns unchanged when only an external reply timestamp moved", () => {
    expect(
      diffReview(
        stored({
          replyText: "Thanks",
          replyModifiedAt: 10,
          repliedVia: "external",
        }),
        fetched({ developerReply: { text: "Thanks", modifiedAt: 99 } }),
      ),
    ).toEqual({ kind: "unchanged" });
  });
});

function fetched(overrides: Partial<Review> = {}): Review {
  return {
    store: "play",
    appId: "com.fusionfroze.Lune",
    reviewId: "review-1",
    author: null,
    rating: 4,
    title: null,
    body: "Body",
    originalBody: null,
    language: null,
    appVersionName: null,
    appVersionCode: null,
    osVersion: null,
    device: null,
    thumbsUp: 1,
    modifiedAt: MODIFIED_AT,
    developerReply: null,
    ...overrides,
  };
}

function stored(overrides: Partial<StoredReview> = {}): StoredReview {
  const review = fetched();
  return {
    id: 1,
    store: review.store,
    appId: review.appId,
    reviewId: review.reviewId,
    rating: review.rating,
    previousRating: null,
    title: review.title,
    body: review.body,
    originalBody: review.originalBody,
    language: review.language,
    author: review.author,
    appVersionName: review.appVersionName,
    appVersionCode: review.appVersionCode,
    osVersion: review.osVersion,
    device: review.device,
    thumbsUp: review.thumbsUp,
    modifiedAt: review.modifiedAt,
    firstSeenAt: 1_600_000_000,
    replyText: null,
    replyModifiedAt: null,
    repliedVia: null,
    repliedBy: null,
    repliedAt: null,
    ...overrides,
  };
}
