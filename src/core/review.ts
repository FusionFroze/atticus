// The store-agnostic review. Play's raw JSON is normalised into this in v1-2.
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
