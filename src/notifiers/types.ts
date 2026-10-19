import type { StoredReview } from "../core/review";

export type MessageRef = {
  channelId: string;
  messageId: string;
  guildId?: string;
};

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
  showUpdated: boolean;
};

export type NoticeInput =
  | {
      kind: "connected";
      appName: string;
      count: number;
      backfill: "post" | "silent";
    }
  | { kind: "warning"; warning: "google_auth" }
  | { kind: "warning"; warning: "play_forbidden"; appName: string }
  | { kind: "recovered"; subject: "google_auth" }
  | { kind: "recovered"; subject: "play_forbidden"; appName: string };

export type DigestInput = { appName: string; text: string };

// One method per outbox kind. Rendering uses Review rows, never Play's raw JSON.
// digest stays pending until v1-6.
export interface Notifier {
  postReview(
    input: ReviewMessageInput,
    nonce: string,
    previous?: MessageRef | null,
  ): Promise<SendResult>;
  updateReview(ref: MessageRef, input: ReviewMessageInput): Promise<SendResult>;
  postNotice(input: NoticeInput, nonce: string): Promise<SendResult>;
  postDigest(input: DigestInput, nonce: string): Promise<SendResult>;
}
