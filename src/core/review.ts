// The store-agnostic review. sources/play normalises Play's raw JSON into this.
export type Store = "play";

export type Review = {
  store: Store;
  appId: string;
  reviewId: string;
  author: string | null;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;
  body: string;
  originalBody: string | null;
  language: string | null;
  appVersionName: string | null;
  appVersionCode: number | null;
  osVersion: string | null;
  device: string | null;
  thumbsUp: number;
  modifiedAt: number;
  developerReply: { text: string; modifiedAt: number } | null;
};

// The reviews row the diff compares. Epoch seconds. repliedVia is null when there is no reply.
export type StoredReview = {
  id: number;
  store: Store;
  appId: string;
  reviewId: string;
  rating: Review["rating"];
  previousRating: Review["rating"] | null;
  title: string | null;
  body: string;
  originalBody: string | null;
  language: string | null;
  author: string | null;
  appVersionName: string | null;
  appVersionCode: number | null;
  osVersion: string | null;
  device: string | null;
  thumbsUp: number;
  modifiedAt: number;
  firstSeenAt: number;
  replyText: string | null;
  replyModifiedAt: number | null;
  repliedVia: "bot" | "external" | null;
  repliedBy: string | null;
  repliedAt: number | null;
};
