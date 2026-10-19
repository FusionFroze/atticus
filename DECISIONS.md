# Decisions

The short, public list of how Atticus is built and why. Each line points to the full decision in [`docs/v1/V1.md`](docs/v1/V1.md) (V-numbers), which also records every departure from [`SPEC.md`](SPEC.md) in its deviations register. Newest decisions are added at the bottom of their section.

## Foundations

- **One Cloudflare Worker on the free tier, self-hosted** (V1). One deploy, one config, one log stream, no running cost, and nobody else ever holds your credentials.
- **Zero runtime dependencies** (V2). Google's JWT signing and Discord's Ed25519 verification use the Workers' built-in WebCrypto, so there's nothing to audit or update and the bundle stays tiny.
- **Tests run inside the Workers runtime with `@cloudflare/vitest-plugin`** (V2). Cloudflare replaced `@cloudflare/vitest-pool-workers`. Outbound HTTP in tests is stubbed with `fetch`, because Cloudflare removed `fetchMock`.
- **The name is Atticus** (V3). Short and human, and not tied to one store or chat app.
- **TypeScript, strict, small files** (V4), so contributors can read the whole thing.

## Configuration

- **One `APPS` list plus flat global settings** (V10). Per-app settings become fields, not new variables, as features grow.
- **Config errors are reported all at once, with what to fix, and never echo a secret** (V11).

## Storage and delivery

- **D1 only, with numbered migrations** (V20, V21). Upgrades are one command.
- **An outbox: write to D1 first, send to Discord later, never twice** (V22). Discord's message nonce closes the crash window between sending and recording.
- **One budget of 45 external calls per run** (V23), because the free plan allows 50. Backlogs drain over the next runs.
- **A lease so overlapping runs never both send** (V24).
- **Buttons carry a short numeric review id** (V25), because Discord's `custom_id` is capped at 100 characters.
- **The Google access token is cached in memory, not stored** (V26).

## Polling and reviews

- **One cron every 15 minutes does everything, including the digest timing** (V30, V71). The digest follows your `TIMEZONE`, handles daylight saving, and uses no extra cron trigger.
- **Each store is an adapter behind one `Review` type** (V40), so App Store support can plug in later without touching the core.
- **Precise diff rules** for new, edited, replied-elsewhere and reply-removed reviews (V32), and per-app first-run handling (V33).
- **First run is `post` or `silent`** (V33). There is no `summary` mode. The Connected message carries the count either way.

## Discord

- **The message look is chosen on real messages, not on paper** (V41).
- **Only a review's latest message has buttons** (V42).
- **Nothing in a review can ping anyone** (V43): every message sets `allowed_mentions`.
- **The review message is a Components V2 container** (V41). Locked 2026-10-19 in the test channel. The low-rating mention sits in a Text Display, because a V2 message cannot include `content`.

## Replies

- **Every interaction is signature-verified, and only allow-listed users in the configured channel can reply** (V51). A timestamp more than 5 minutes off the Worker clock, in either direction, is rejected as well. Discord does not require that window.
- **The interaction webhook edit stays in the Discord notifier** (V53). `jobs/reply` publishes the reply and writes D1. It does not import a chat platform.
- **Replies are written by humans, published in the background after Discord's 3-second window, and never retried blindly** (V53, V54).
- **`DRY_RUN` shows the reply in Discord without publishing it or changing the database** (V55).

## Health

- **Warnings are posted once and cleared once** (V60), so a broken permission doesn't spam the channel every 15 minutes.
- **Logs carry ids and statuses, never review text, names or secrets** (V62).
