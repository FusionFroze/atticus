import type { AppConfig } from "../config/types";
import type { Review, Store } from "../core/review";
import type { Budget } from "../lib/budget";

// Token-exchange failures are `auth`, including a network error talking to the token endpoint.
// A network error talking to the Play API is `unavailable` with status 0.
export interface ReviewSource {
  readonly store: Store;
  listRecent(app: AppConfig, budget: Budget): Promise<ListResult>;
  reply(
    app: AppConfig,
    reviewId: string,
    text: string,
    budget: Budget,
  ): Promise<ReplyResult>;
}

export type SourceFailure =
  | { kind: "auth" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "invalid"; detail: string }
  | { kind: "rate_limited" }
  | { kind: "unavailable"; status: number }
  | { kind: "budget" };

export type ListResult =
  | { ok: true; reviews: Review[]; truncated: boolean }
  | { ok: false; failure: SourceFailure };

export type ReplyResult = { ok: true } | { ok: false; failure: SourceFailure };
