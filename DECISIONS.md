# Decisions

The short, public list of how Atticus is built and why. Each line points to the full decision in [`docs/v1/V1.md`](docs/v1/V1.md) (V-numbers), which also records every departure from [`SPEC.md`](SPEC.md) in its deviations register. Newest decisions are added at the bottom of their section.

## Foundations

- **One Cloudflare Worker on the free tier, self-hosted** (V1). One deploy, one config, one log stream, no running cost, and nobody else ever holds your credentials.
- **Zero runtime dependencies** (V2). Google's JWT signing and Discord's Ed25519 verification use the Workers' built-in WebCrypto, so there's nothing to audit or update and the bundle stays tiny.
- **Tests run inside the Workers runtime with `@cloudflare/vitest-plugin`** (V2). Cloudflare replaced `@cloudflare/vitest-pool-workers`. Outbound HTTP in tests is stubbed with `fetch`, because Cloudflare removed `fetchMock`.
- **The name is Atticus** (V3). Short and human, and not tied to one store or chat app.
- **TypeScript, strict, small files** (V4), so contributors can read the whole thing.
- **MIT, developed in the open once v1.0.0 ships** (V5). The repo stays private until a full-history secrets scan is clean.
- **Every user deploys their own copy** (V1). There is no hosted Atticus. Upstream `wrangler.jsonc` is a template with `REPLACE_WITH_…` values, so a forgotten value fails loudly instead of posting somewhere unexpected.

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
- **A run reads its state once and writes its bookkeeping once** (v1-7). One D1 batch takes the lease and reads every `state` row; one batch at the end records the poll, prunes and releases the lease. Each message sent costs two D1 requests. That cut a busy run from about 220 D1 requests to about 90.
- **Cron CPU sits around the free plan's 10 ms, and that's accepted** (v1-7). Every cron starts in a fresh isolate, so it pays a fixed cold-start cost of about 9–15 ms. Signing and `Intl` were measured at about 1 ms or less, so caching the token in D1 wouldn't help. No run was stopped in testing; the dashboard's "Exceeded CPU Time Limits" is the thing to watch.

## Polling and reviews

- **One cron every 15 minutes does everything, including the digest timing** (V30, V71). The digest follows your `TIMEZONE`, handles daylight saving, and uses no extra cron trigger.
- **Each store is an adapter behind one `Review` type** (V40), so App Store support can plug in later without touching the core.
- **Precise diff rules** for new, edited, replied-elsewhere and reply-removed reviews (V32), and per-app first-run handling (V33).
- **First run is `post` or `silent`** (V33). There is no `summary` mode. The Connected message carries the count either way.

## Discord

- **The message look is chosen on real messages, not on paper** (V41).
- **Only a review's latest message has buttons** (V42).
- **An edited review is posted as a new message that replies to the old one** (V42, v1-5). The old message keeps its text, loses its buttons and links to the new one.
- **Nothing in a review can ping anyone** (V43): every message sets `allowed_mentions`.
- **The review message is a Components V2 container** (V41). Locked 2026-10-19 in the test channel. The low-rating mention sits in a Text Display, because a V2 message cannot include `content`.
- **Discord REST with a bot token only, no gateway** (V44). Nothing stays connected, which is what a cron Worker can do.
- **The bot needs View Channel, Send Messages and Read Message History** (v1-7). Read Message History is required to post a message as a reply, which edited reviews are. Components V2 needs no Embed Links.
- **A deleted review message is posted again** (V61) the next time that review changes, and becomes its latest message.

## Replies

- **Every interaction is signature-verified, and only allow-listed users in the configured channel can reply** (V51). A timestamp more than 5 minutes off the Worker clock, in either direction, is rejected as well. Discord does not require that window.
- **One route, `POST /interactions`** (V50). Everything else is an empty 404.
- **The reply modal is one Label wrapping one text input, capped at 350 characters** (V52), Google's reply limit. Edit reply is prefilled with the stored reply.
- **The interaction webhook edit stays in the Discord notifier** (V53). `jobs/reply` publishes the reply and writes D1. It does not import a chat platform.
- **Replies are written by humans, published in the background after Discord's 3-second window, and never retried blindly** (V53, V54).
- **`DRY_RUN` shows the reply in Discord without publishing it or changing the database** (V55).
- **Changes are tested on a separate dev Worker, Discord app and channel** (V80), with `DRY_RUN` on. A real reply on Google Play is published only with the owner's go-ahead for that reply (V82).

## Health

- **Warnings are posted once and cleared once** (V60), so a broken permission doesn't spam the channel every 15 minutes.
- **Logs carry ids and statuses, never review text, names or secrets** (V62).

## Digest

- **One digest per app** (v1-6). Each app gets its own weekly message.
- **A quiet week still posts** (v1-6). The message is one line, "No written reviews this week.", under the written-reviews label.
