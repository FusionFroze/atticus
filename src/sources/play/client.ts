import type { Budget } from "../../lib/budget";
import { isRecord } from "../../lib/record";
import type { ReplyResult, SourceFailure } from "../types";
import type { PlayReview } from "./types";

const PLAY_ORIGIN =
  "https://www.googleapis.com/androidpublisher/v3/applications";

// Five pages is 500 reviews, which keeps one app inside the run budget (V31).
const MAX_PAGES = 5;
const MAX_RESULTS = 100;

export type ListedReview = PlayReview & { reviewId: string };

export type ListReviewsResult =
  | { ok: true; reviews: ListedReview[]; truncated: boolean }
  | { ok: false; failure: SourceFailure };

export type ListReviewsInput = {
  packageName: string;
  translationLanguage: string | null;
  accessToken: string;
  budget: Budget;
};

export type ReplyInput = {
  packageName: string;
  reviewId: string;
  text: string;
  accessToken: string;
  budget: Budget;
};

export async function listReviews(
  input: ListReviewsInput,
): Promise<ListReviewsResult> {
  const reviews: ListedReview[] = [];
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const fetched = await fetchPage(input, pageToken);
    if (!fetched.ok) return fetched;
    reviews.push(...fetched.reviews);
    if (fetched.nextPageToken === null) {
      return { ok: true, reviews, truncated: false };
    }
    pageToken = fetched.nextPageToken;
  }

  // The last page still had a next token. There is no cursor to resume from yet,
  // so the pages already read are returned and the caller logs poll_truncated.
  return { ok: true, reviews, truncated: true };
}

export async function reply(input: ReplyInput): Promise<ReplyResult> {
  const url = `${PLAY_ORIGIN}/${encodeURIComponent(input.packageName)}/reviews/${encodeURIComponent(input.reviewId)}:reply`;
  const response = await request(
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ replyText: input.text }),
    },
    input.budget,
    "too long or empty",
  );
  if (!response.ok) return response;
  await response.response.body?.cancel();
  return { ok: true };
}

type PageResult =
  | { ok: true; reviews: ListedReview[]; nextPageToken: string | null }
  | { ok: false; failure: SourceFailure };

async function fetchPage(
  input: ListReviewsInput,
  pageToken: string | null,
): Promise<PageResult> {
  const url = new URL(
    `${PLAY_ORIGIN}/${encodeURIComponent(input.packageName)}/reviews`,
  );
  url.searchParams.set("maxResults", String(MAX_RESULTS));
  if (input.translationLanguage !== null) {
    url.searchParams.set("translationLanguage", input.translationLanguage);
  }
  if (pageToken !== null) url.searchParams.set("token", pageToken);

  const response = await request(
    url.toString(),
    { headers: { authorization: `Bearer ${input.accessToken}` } },
    input.budget,
    "bad request",
  );
  if (!response.ok) return response;

  let body: unknown;
  try {
    body = await response.response.json();
  } catch {
    return {
      ok: false,
      failure: { kind: "invalid", detail: "malformed response" },
    };
  }
  if (!isRecord(body)) {
    return {
      ok: false,
      failure: { kind: "invalid", detail: "malformed response" },
    };
  }

  const reviews = readReviews(body.reviews);
  if (reviews === null) {
    return {
      ok: false,
      failure: { kind: "invalid", detail: "malformed response" },
    };
  }
  const nextPageToken = readNextPageToken(body.tokenPagination);
  if (nextPageToken === "invalid") {
    return {
      ok: false,
      failure: { kind: "invalid", detail: "malformed response" },
    };
  }
  return { ok: true, reviews, nextPageToken };
}

type HttpResult =
  | { ok: true; response: Response }
  | { ok: false; failure: SourceFailure };

async function request(
  url: string,
  init: RequestInit,
  budget: Budget,
  invalidDetail: string,
): Promise<HttpResult> {
  if (!budget.take()) return { ok: false, failure: { kind: "budget" } };

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    return { ok: false, failure: { kind: "unavailable", status: 0 } };
  }

  if (!response.ok) {
    const failure = mapHttpStatus(response.status, invalidDetail);
    await response.body?.cancel();
    return { ok: false, failure };
  }
  return { ok: true, response };
}

function mapHttpStatus(status: number, invalidDetail: string): SourceFailure {
  if (status === 400) return { kind: "invalid", detail: invalidDetail };
  if (status === 401) return { kind: "auth" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  if (status === 429) return { kind: "rate_limited" };
  return { kind: "unavailable", status };
}

function readReviews(value: unknown): ListedReview[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const reviews: ListedReview[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.reviewId !== "string" ||
      entry.reviewId === ""
    ) {
      return null;
    }
    reviews.push({ ...entry, reviewId: entry.reviewId });
  }
  return reviews;
}

function readNextPageToken(value: unknown): string | null | "invalid" {
  if (value === undefined) return null;
  if (!isRecord(value)) return "invalid";
  const token = value.nextPageToken;
  if (token === undefined || token === "") return null;
  if (typeof token !== "string") return "invalid";
  return token;
}
