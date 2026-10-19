import type { StoredReview } from "../core/review";

export type MessageRef = { channelId: string; messageId: string };

export type SendFailure =
  | { kind: "rate_limited"; retryAfterMs: number }
  | { kind: "gone" }
  | { kind: "channel" }
  | { kind: "invalid"; status: number }
  | { kind: "unavailable"; status: number }
  | { kind: "budget" };

export type SendResult =
  | { ok: true; ref: MessageRef }
  | { ok: false; failure: SendFailure };

export type ReviewMessageInput = {
  review: StoredReview;
  appName: string;
  consoleUrl: string | null;
  mention: { kind: "role" | "user"; id: string } | null;
};

export type NoticeInput =
  | {
      kind: "connected";
      appName: string;
      count: number;
      backfill: "post" | "silent";
    }
  | { kind: "warning"; text: string }
  | { kind: "recovered"; text: string };

export type DigestInput = { appName: string; text: string };

// One method per outbox kind. Rendering uses Review rows, never Play's raw JSON.
// warning, recovered, and digest stay pending until v1-5 and v1-6.
export interface Notifier {
  postReview(input: ReviewMessageInput, nonce: string): Promise<SendResult>;
  updateReview(ref: MessageRef, input: ReviewMessageInput): Promise<SendResult>;
  postNotice(input: NoticeInput, nonce: string): Promise<SendResult>;
  postDigest(input: DigestInput, nonce: string): Promise<SendResult>;
}
