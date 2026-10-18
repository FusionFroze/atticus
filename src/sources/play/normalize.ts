import type { Review } from "../../core/review";
import { isRecord } from "../../lib/record";
import type { ListedReview } from "./client";

// A bad rating or timestamp skips that review. Normalising never throws.
// `text` splits on the first tab; an empty title becomes null. `originalText` is stored whole.
// `lastModified.seconds` has to be a canonical safe-integer string (Google sends a string).
export type SkipReason = "rating" | "last_modified";

const EPOCH_SECONDS = /^-?(0|[1-9]\d*)$/;

export function normalizeReview(
  appId: string,
  raw: ListedReview,
): Review | { reviewId: string; reason: SkipReason } {
  const user = readUserComment(raw);
  if (user === null) return skip(raw.reviewId, "rating");

  const rating = readRating(user.starRating);
  if (rating === null) return skip(raw.reviewId, "rating");

  const modifiedAt = readUserSeconds(user);
  if (modifiedAt === null) return skip(raw.reviewId, "last_modified");

  const text = splitText(user.text);
  return {
    store: "play",
    appId,
    reviewId: raw.reviewId,
    author: optionalString(raw.authorName),
    rating,
    title: text.title,
    body: text.body,
    originalBody: optionalString(user.originalText),
    language: optionalString(user.reviewerLanguage),
    appVersionName: optionalString(user.appVersionName),
    appVersionCode: readVersionCode(user.appVersionCode),
    osVersion: readOsVersion(user.androidOsVersion),
    device: readDevice(user),
    thumbsUp: readThumbs(user.thumbsUpCount),
    modifiedAt,
    developerReply: readDeveloperReply(raw),
  };
}

function skip(
  reviewId: string,
  reason: SkipReason,
): { reviewId: string; reason: SkipReason } {
  return { reviewId, reason };
}

function readUserComment(raw: ListedReview): Record<string, unknown> | null {
  if (!Array.isArray(raw.comments)) return null;
  for (const comment of raw.comments) {
    if (!isRecord(comment) || !isRecord(comment.userComment)) continue;
    return comment.userComment;
  }
  return null;
}

function readDeveloperReply(
  raw: ListedReview,
): { text: string; modifiedAt: number } | null {
  if (!Array.isArray(raw.comments)) return null;
  for (const comment of raw.comments) {
    if (!isRecord(comment) || !isRecord(comment.developerComment)) continue;
    const text = optionalString(comment.developerComment.text);
    if (text === null) continue;
    const lastModified = comment.developerComment.lastModified;
    const seconds = isRecord(lastModified) ? lastModified.seconds : undefined;
    return { text, modifiedAt: readEpochSeconds(seconds) ?? 0 };
  }
  return null;
}

function readUserSeconds(user: Record<string, unknown>): number | null {
  if (!isRecord(user.lastModified)) return null;
  return readEpochSeconds(user.lastModified.seconds);
}

function readEpochSeconds(value: unknown): number | null {
  if (typeof value !== "string" || !EPOCH_SECONDS.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || String(parsed) !== value) return null;
  return parsed;
}

function readRating(value: unknown): 1 | 2 | 3 | 4 | 5 | null {
  if (value === 1 || value === 2 || value === 3 || value === 4 || value === 5) {
    return value;
  }
  return null;
}

function splitText(value: unknown): { title: string | null; body: string } {
  if (typeof value !== "string") return { title: null, body: "" };
  const tab = value.indexOf("\t");
  if (tab === -1) return { title: null, body: value };
  const title = value.slice(0, tab);
  return { title: title === "" ? null : title, body: value.slice(tab + 1) };
}

function readDevice(user: Record<string, unknown>): string | null {
  if (isRecord(user.deviceMetadata)) {
    const productName = optionalString(user.deviceMetadata.productName);
    if (productName !== null) return productName;
  }
  return optionalString(user.device);
}

function readOsVersion(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return String(value);
}

function readVersionCode(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

function readThumbs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function optionalString(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return value;
}
