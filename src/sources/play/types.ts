// Raw Reply to Reviews JSON. Every field is optional except where a test has already
// required it: Google marks most of the review resource optional.
export type PlayTimestamp = {
  seconds?: string;
  nanos?: number;
};

export type PlayDeviceMetadata = {
  productName?: string;
  manufacturer?: string;
  deviceClass?: string;
  screenWidthPx?: number;
  screenHeightPx?: number;
  nativePlatform?: string;
  screenDensityDpi?: number;
  glEsVersion?: number;
  cpuModel?: string;
  cpuMake?: string;
  ramMb?: number;
};

export type PlayUserComment = {
  text?: string;
  lastModified?: PlayTimestamp;
  starRating?: number;
  reviewerLanguage?: string;
  device?: string;
  androidOsVersion?: number;
  appVersionCode?: number;
  appVersionName?: string;
  thumbsUpCount?: number;
  thumbsDownCount?: number;
  deviceMetadata?: PlayDeviceMetadata;
  originalText?: string;
};

export type PlayDeveloperComment = {
  text?: string;
  lastModified?: PlayTimestamp;
};

export type PlayComment = {
  userComment?: PlayUserComment;
  developerComment?: PlayDeveloperComment;
};

export type PlayReview = {
  reviewId?: string;
  authorName?: string;
  comments?: PlayComment[];
};

export type PlayReviewsPage = {
  reviews?: PlayReview[];
  tokenPagination?: {
    nextPageToken?: string;
  };
};
