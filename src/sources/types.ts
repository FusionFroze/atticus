// ReviewSource, which returns normalised Review values, lands in v1-2.
// Token-exchange failures are `auth`, including a network error talking to the token endpoint.
// A network error talking to the Play API is `unavailable` with status 0.
export type SourceFailure =
  | { kind: "auth" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "invalid"; detail: string }
  | { kind: "rate_limited" }
  | { kind: "unavailable"; status: number }
  | { kind: "budget" };

export type ReplyResult = { ok: true } | { ok: false; failure: SourceFailure };
