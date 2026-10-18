# Play Reviews Bot: Build Spec

> **Working name:** `play-reviews-bot` (rename freely; see Open Questions)
> **Owner:** FusionFroze (github.com/fusionfroze)
> **First user:** Lune (`com.fusionfroze.Lune`)
> **Status:** v1 spec, written Oct 2026, before build
> **License:** MIT (open source)

---

## 0. How to use this document (read first, Cursor)

This spec gives you the **context, constraints and intent** behind the project, plus a recommended design.

Treat the sections differently:

- **§4 Constraints and §11 Security are non-negotiable** unless the owner explicitly changes them.
- **§5 Platform facts were verified against official docs in Oct 2026.** Re-verify anything that looks off; APIs drift.
- **Everything else (architecture, file layout, libraries, message design, data model) is a recommendation.** If you find a simpler or more robust way while building, take it. Record the change in `DECISIONS.md` with one line of reasoning.
- **Do not pad the scope.** If a choice comes down to "more features" vs "a smaller, solid v1", pick the solid v1.
- **When the spec is silent, optimise for:** (1) the owner can deploy it in under 15 minutes, (2) nothing needs maintenance once deployed, (3) the code stays small and readable for open-source contributors.

---

## 1. One-paragraph summary

A self-hosted bot that watches an Android app's Google Play reviews and posts each new or edited review to a Discord channel within minutes. The developer can **reply to the review directly from Discord**: click Reply, type in a modal, submit, and the reply is published on Google Play. A weekly digest summarises recent feedback. The whole thing runs as **one Cloudflare Worker** on the free tier: no server, no database to babysit, no monthly cost.

---

## 2. Problem, goals, non-goals

### Problem
- Play Console has no good real-time notification for new reviews. Developers check manually, often days late.
- Fast replies matter: users are notified when you reply, and a quick, human reply to a 1-star review can change the rating.
- The Play API only exposes reviews **from the last 7 days**, so any tool that wants history has to store reviews itself.
- Existing solutions are paid SaaS (AppFollow, Appbot, AppReviewBot) or old, notify-only scripts. Free tools that **let you reply from chat** are rare.

### Goals (v1)
1. New written reviews appear in Discord within ~15 minutes.
2. Reply to a review from Discord without opening Play Console.
3. Edited reviews and replies made elsewhere (e.g., in Play Console) are reflected, not duplicated.
4. A weekly digest of recent feedback.
5. Deployable by a solo developer in under 15 minutes with a clear README.
6. Runs entirely on free tiers, with zero ongoing maintenance.

### Non-goals (v1)
- Star-only ratings (no text). **The API does not expose them** (§5).
- Overall store rating or install counts (different APIs and reporting buckets; possible later).
- iOS / App Store Connect (planned v2; keep the code shaped for it).
- Fully automated replies. Google discourages them, and they hurt trust. AI may **draft** in v2; a human always approves.
- A hosted multi-tenant SaaS. Self-hosted only, no storing other people's credentials.
- A web dashboard.

---

## 3. Users

- **Primary:** a solo indie Android developer with a live production app and a Discord server (the owner, for Lune).
- **Secondary:** small teams who want reviews in a shared channel and someone on the team to answer them.

User assumptions: comfortable with a terminal and `wrangler`, can create a Google Cloud service account by following steps, has a Discord server they admin.

---

## 4. Constraints (non-negotiable)

| Constraint | Why |
|---|---|
| **No traditional backend to maintain.** One Cloudflare Worker plus Cloudflare storage. | Owner is solo and focused on another product. |
| **Free tier only.** Cloudflare Workers free plan, D1 free, Discord free, Google API free quotas. | No running costs. |
| **Self-hosted.** Each user deploys their own Worker with their own secrets. | The project never holds anyone else's Play credentials. |
| **Human-approved replies only.** No auto-posting of replies. | Google discourages automated replies; replies are public. |
| **Only allow-listed Discord users can reply.** | Replies publish publicly on Google Play under the developer's name. |
| **Small codebase.** TypeScript, minimal dependencies. | Open source; easy to read and contribute to. |
| **Build window: ~1 week**, built with Cursor. | Leftover credits; time is borrowed from the main product. |

---

## 5. Platform facts (verified Oct 2026)

### Google Play Developer API: Reply to Reviews
Source: https://developers.google.com/android-publisher/reply-to-reviews

- **Production only.** Only reviews for production versions of the app are available; alpha/beta feedback is not.
- **Text reviews only.** Ratings without a comment are **not** returned.
- **7-day window.** Only reviews **created or modified within the last week** are returned.
- **List:** `GET https://www.googleapis.com/androidpublisher/v3/applications/{packageName}/reviews`
  - Most recently created or modified first.
  - Default 10 per page, max 100 via `maxResults`. Paginate with `token` = `tokenPagination.nextPageToken`.
  - Optional `translationLanguage` (e.g., `en`). If it differs from the review language, `text` is translated and `originalText` holds the original.
- **Get one:** `GET .../reviews/{reviewId}`
- **Reply:** `POST .../reviews/{reviewId}:reply` with JSON `{ "replyText": "..." }`
  - **Max 350 characters**, plain text. Well-formed HTML tags are stripped.
  - Errors: `400` (too long or missing), `404` (review not found).
  - Replying again **replaces** the existing reply.
- **Notifications to the user:** sent on the **first** reply to a created or modified review. **Editing your reply does not notify the user.** If the user updates their review and you update your reply, they are notified again.
- **Review shape (relevant fields):**
  - `reviewId` (one per user per app; edits keep the same ID), `authorName` (may be missing)
  - `comments[0].userComment`: `text` (title and body separated by a tab if a title exists), `lastModified.seconds`, `starRating` (1–5), `reviewerLanguage`, `device`, `androidOsVersion`, `appVersionCode`, `appVersionName`, `thumbsUpCount`, `thumbsDownCount`, `deviceMetadata` (`productName`, `manufacturer`, `ramMb`, …), `originalText` (if translated)
  - `comments[1].developerComment` (if replied): `text`, `lastModified`
  - Many fields are optional; code defensively.
- **Quotas (per app):** `GET` 200/hour, `POST` 2000/day. Polling every 15 minutes uses ~4 GETs per hour. Pagination adds more, but stays well within quota.

### Auth: service account
Source: https://developers.google.com/android-publisher/getting_started
1. Google Cloud Console: create or choose a project, enable **Google Play Android Developer API**.
2. IAM & Admin → Service Accounts → create one → create a **JSON key**.
3. Play Console → **Users and permissions → Invite new users** → paste the service account email (`client_email`) → grant access to the app with the **"Reply to reviews"** permission (and view permissions as needed) → Invite.
4. Access token: sign a JWT (RS256) with the key, exchange it at `https://oauth2.googleapis.com/token`, scope `https://www.googleapis.com/auth/androidpublisher`. Tokens last ~1 hour.
   - On Workers, sign with **WebCrypto** (import the PKCS#8 private key). Avoid the heavy `googleapis` package.
   - New service-account permissions can take a while to propagate. The README should warn about "permission denied" errors right after setup.

### Discord
Verify against the current Discord developer docs before implementing; component and modal APIs have evolved.
- Post messages via the **bot token** and REST: `POST /channels/{channel.id}/messages`. No gateway connection is needed.
- Interactive buttons require an **application-owned** message (bot token or application-owned webhook), not a plain channel webhook.
- **Interactions endpoint:** an HTTPS URL (the Worker) set in the Discord app settings. Every request must be **Ed25519 signature verified**. `PING` must be answered with `PONG`.
- Interactions must be answered within **3 seconds**. For anything slower (the Play API call), respond with a deferred type, finish the work with `ctx.waitUntil`, then edit the message or send a follow-up via the interaction token (valid ~15 minutes).
- Relevant response types: `MODAL` (show the reply form), `DEFERRED_UPDATE_MESSAGE`, `UPDATE_MESSAGE`, `CHANNEL_MESSAGE_WITH_SOURCE` (ephemeral errors).
- Modal text input: use the paragraph style with `max_length: 350` to match Play's limit.

### Cloudflare
- **Cron Triggers** run the Worker's `scheduled()` handler on a schedule; included on the free plan.
- **D1** (SQLite) for storage; free tier is ample for this volume.
- **Secrets** via `wrangler secret put`.
- Verify current free-tier limits before finalising; nothing in this design comes close to them.

---

## 6. Architecture (recommended)

```
             ┌─────────────── Cloudflare Worker (single deployment) ──────────────┐
             │                                                                    │
 Cron ──────▶│ scheduled()                                                        │
 (*/15 min)  │   ├─ getAccessToken() ── JWT ──▶ oauth2.googleapis.com              │
 (weekly)    │   ├─ listReviews() ────────────▶ androidpublisher v3 /reviews      │
             │   ├─ diff vs D1 (new / edited / replied-elsewhere)                  │
             │   ├─ notifier.post/update() ───▶ Discord REST (bot token)          │
             │   └─ weekly: buildDigest() ────▶ Discord REST                      │
             │                                                                    │
 Discord ───▶│ fetch() /interactions                                              │
 (button,    │   ├─ verify Ed25519 signature                                      │
  modal)     │   ├─ check user allow-list                                         │
             │   ├─ Reply button → return MODAL                                   │
             │   └─ Modal submit → DEFERRED_UPDATE → waitUntil(                   │
             │          replyToReview() ──────▶ androidpublisher v3 :reply        │
             │          edit Discord message with the published reply)            │
             │                                                                    │
             │ D1: reviews, discord_messages, state                               │
             └────────────────────────────────────────────────────────────────────┘
```

**Why one Worker:** one deploy, one config, one log stream, and the cron and interaction handlers share code. An earlier idea was GitHub Actions for polling plus a Worker for interactions. That's two systems for no gain, so it's dropped (owner may revisit).

**Module boundaries (keep these even if file names change):**
- `play/`: auth (JWT and token cache), list reviews (pagination), reply. **No Discord knowledge.**
- `notifiers/`: a `Notifier` interface plus a `discord` implementation. **No Play knowledge.** Telegram plugs in here later.
- `core/`: diffing, review normalisation, digest building, config parsing. Pure functions, fully unit-tested.
- `store/`: D1 access.
- `index.ts`: wires `scheduled()` and `fetch()`.

Normalise Play's nested review shape into an internal `Review` type early (in `core/`), so notifiers and the digest never touch raw API JSON. This is also what makes adding App Store reviews in v2 cheap.

```ts
// Suggested internal shape (adjust freely)
type Review = {
  store: "play";                 // "appstore" later
  appId: string;                 // package name
  reviewId: string;
  author: string | null;
  rating: 1 | 2 | 3 | 4 | 5;
  title: string | null;          // split on the tab character if present
  body: string;
  originalBody: string | null;   // present when translated
  language: string | null;
  appVersionName: string | null;
  appVersionCode: number | null;
  androidOsVersion: number | null;
  device: string | null;         // prefer deviceMetadata.productName, fall back to device
  thumbsUp: number;
  modifiedAt: number;            // epoch seconds from userComment.lastModified
  developerReply: { text: string; modifiedAt: number } | null;
};
```

---

## 7. Data model (D1, recommended)

```sql
-- One row per review; history accumulates beyond Play's 7-day window.
CREATE TABLE reviews (
  app_id            TEXT NOT NULL,
  review_id         TEXT NOT NULL,
  rating            INTEGER NOT NULL,
  title             TEXT,
  body              TEXT NOT NULL,
  original_body     TEXT,
  language          TEXT,
  author            TEXT,
  app_version_name  TEXT,
  app_version_code  INTEGER,
  android_os        INTEGER,
  device            TEXT,
  modified_at       INTEGER NOT NULL,   -- user's lastModified (epoch s)
  first_seen_at     INTEGER NOT NULL,
  reply_text        TEXT,
  reply_modified_at INTEGER,
  replied_via       TEXT,               -- 'bot' | 'external' | NULL
  replied_by        TEXT,               -- Discord user id when via bot
  PRIMARY KEY (app_id, review_id)
);

-- Maps a review (and a specific version of it) to its Discord message.
CREATE TABLE discord_messages (
  app_id       TEXT NOT NULL,
  review_id    TEXT NOT NULL,
  modified_at  INTEGER NOT NULL,        -- review version this message represents
  channel_id   TEXT NOT NULL,
  message_id   TEXT NOT NULL,
  PRIMARY KEY (app_id, review_id, modified_at)
);

-- Small key/value state: first-run flag, last poll time, last digest time.
CREATE TABLE state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Store review text: it's needed for the digest and the 7-day API window makes it unrecoverable otherwise. The data stays in the user's own Cloudflare account. Mention this in the README's privacy note.

---

## 8. Behaviour and flows

### 8.1 Polling (cron, default every 15 minutes)
1. Get an access token (cache it in memory and/or D1 `state` until ~5 minutes before expiry).
2. For each configured app: list reviews, **paginating** with `maxResults=100` until there is no `nextPageToken`. Apply `translationLanguage` if configured.
3. Normalise into `Review` objects.
4. For each review, compare with D1:
   - **Not in D1 → NEW.** Insert, then post a Discord message. Store the message mapping.
   - **In D1, `modifiedAt` increased → EDITED.** Update the row, then post a **new** message that clearly says "Review updated" (show old vs new rating if changed), replying to the original message via `message_reference` if it still exists. Re-enable the Reply button: the user changed their review, so a new reply will notify them.
   - **In D1, no bot reply recorded, but the API now shows a `developerComment` → REPLIED ELSEWHERE.** Update the row (`replied_via='external'`), and edit the latest Discord message to show the reply and swap the button to "Edit reply".
   - **Otherwise:** no-op.
5. Post messages oldest-first so the channel reads chronologically, and rate-limit posts (respect Discord's `429` and `Retry-After`).
6. Update `state.last_poll_at`.

**Idempotency:** the cron may overlap or retry. Insert-before-post with a unique key, or a "posted" flag, so a crash between steps can't double-post. Pick whichever is simpler and document it.

### 8.2 First run
The first poll returns up to a week of reviews. Config `BACKFILL` controls it:
- `post` (default for a new app): post them all, oldest first.
- `silent`: store them without posting, so only future reviews notify.
- `summary`: store silently and post a single "Connected ✓ — found N reviews from the last 7 days" message.

Always post a one-time **"Connected" health message** so the user knows setup worked.

### 8.3 Review message (Discord)
Recommended embed layout; iterate freely on looks:
- **Colour by rating:** 1–2 red, 3 amber, 4–5 green.
- **Title:** stars plus rating, e.g. `★★☆☆☆ 2/5`, plus the review title if present.
- **Description:** the review body (translated if configured), truncated safely to Discord's embed limit.
- **Original text** field when translated (collapsed or truncated).
- **Fields (inline):** App version · Android version · Device · Language.
- **Footer:** author name (or "Anonymous"), app name or package, relative time.
- **Buttons:**
  - `Reply` (primary): opens the modal. Hidden or disabled if replied; then `Edit reply`.
  - `Open in Play Console` (link): use a configurable URL (`PLAY_CONSOLE_URL`) pointing to the app's reviews page. Deep links to individual reviews aren't documented, so don't guess the format.
- **Mentions (optional):** if `PING_ON_LOW_RATING` is set to a role or user ID, mention it for 1–2★ reviews only.

### 8.4 Reply flow
1. User clicks **Reply** → Worker verifies the signature and checks the user is in `ALLOWED_USER_IDS` (otherwise an ephemeral "not allowed" message).
2. Worker responds with a **MODAL**:
   - Title: `Reply to {author} ({rating}★)`
   - One paragraph text input, `max_length: 350`, `required: true`, placeholder hinting that the reply is **public**.
   - Encode `appId` and `reviewId` in the modal `custom_id`, e.g. `reply:{appId}:{reviewId}`. Keep it under Discord's custom_id length limit; if needed, store a short key in D1 instead.
   - For **Edit reply**, prefill with the existing reply and add a note that edits don't notify the user.
3. User submits → Worker immediately returns **DEFERRED_UPDATE_MESSAGE**, then in `ctx.waitUntil`:
   - Calls `POST :reply`.
   - On success: update the D1 row (`reply_text`, `replied_via='bot'`, `replied_by`), then **edit the original message**. Add a "Your reply" field with the text plus "Replied by @user · just now", and swap the button to `Edit reply`.
   - On failure: send an **ephemeral follow-up** with a human-readable error (400 too long, 404 review gone, 403 permission missing → point to the setup docs), and keep the message unchanged.
4. Never auto-retry a reply POST blindly. A double-submit just replaces the reply with the same text, so it's harmless, but log it.

### 8.5 Weekly digest (cron, default Monday 09:00 in `TIMEZONE`)
Built from D1 for the last 7 days. Recommended content:
- Number of new and edited written reviews, and average rating of **written** reviews, compared with the previous week.
- Rating distribution (1–5 bars in text).
- Reply rate and median time-to-reply for bot replies.
- Breakdown by app version (spot a bad release).
- The lowest-rated unanswered reviews (max 3), with links to their messages.

Label it honestly: **"written reviews only"**. The store's overall rating includes star-only ratings this API can't see.

### 8.6 Commands (optional, v1.1)
Slash commands are nice-to-have, not required for v1:
- `/reviews unanswered`: list unanswered reviews from the stored history.
- `/reviews digest`: post the digest now.
- `/reviews status`: last poll time, token health, counts.

Registering commands needs a one-off script (`scripts/register-commands.ts`).

---

## 9. Configuration

Use `wrangler.toml` vars for non-secrets and `wrangler secret put` for secrets. Validate all config at startup and fail with **clear, actionable messages** (e.g., "`DISCORD_CHANNEL_ID` is missing — see README §Discord setup").

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `PLAY_PACKAGE_NAMES` | var | ✓ | — | Comma-separated, e.g. `com.fusionfroze.Lune`. Multi-app ready. |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | ✓ | — | Full JSON key. Parse `client_email` and `private_key`. |
| `DISCORD_BOT_TOKEN` | secret | ✓ | — | |
| `DISCORD_PUBLIC_KEY` | var | ✓ | — | For Ed25519 verification. |
| `DISCORD_APPLICATION_ID` | var | ✓ | — | For follow-ups and commands. |
| `DISCORD_CHANNEL_ID` | var | ✓ | — | Where reviews are posted. Per-app channels could come later. |
| `ALLOWED_USER_IDS` | var | ✓ | — | Comma-separated Discord user IDs allowed to reply. **Required; never default to "everyone".** |
| `TRANSLATION_LANGUAGE` | var | | unset | e.g. `en`. Unset means no translation. |
| `BACKFILL` | var | | `post` | `post` / `silent` / `summary` |
| `PING_ON_LOW_RATING` | var | | unset | Role ID (`&123`) or user ID to mention on 1–2★. |
| `PLAY_CONSOLE_URL` | var | | unset | Link-button target. |
| `TIMEZONE` | var | | `UTC` | For digest timing and display (owner uses `Asia/Kolkata`). |
| `DIGEST_ENABLED` | var | | `true` | |
| `DRY_RUN` | var | | `false` | When `true`, the reply flow logs instead of POSTing to Play. Used for testing. |

Cron schedules live in `wrangler.toml` (`triggers.crons`). Note that Cloudflare cron is UTC; convert digest time from `TIMEZONE`, or document it.

---

## 10. Repository layout (suggested)

```
play-reviews-bot/
├─ src/
│  ├─ index.ts              # scheduled() + fetch() wiring
│  ├─ config.ts             # parse + validate env
│  ├─ play/
│  │  ├─ auth.ts            # service-account JWT → access token (WebCrypto)
│  │  ├─ reviews.ts         # list (paginated), get, reply
│  │  └─ types.ts           # raw API types
│  ├─ core/
│  │  ├─ normalize.ts       # raw → Review
│  │  ├─ diff.ts            # new / edited / replied-elsewhere
│  │  └─ digest.ts          # weekly stats from rows
│  ├─ notifiers/
│  │  ├─ types.ts           # Notifier interface
│  │  └─ discord/
│  │     ├─ client.ts       # REST calls, 429 handling
│  │     ├─ messages.ts     # embeds/components builders
│  │     └─ interactions.ts # verify, route buttons/modals
│  └─ store/
│     ├─ schema.sql
│     └─ db.ts
├─ scripts/
│  └─ register-commands.ts  # optional (v1.1)
├─ test/
│  ├─ fixtures/             # sample Play API responses (incl. edge cases)
│  └─ *.test.ts
├─ wrangler.toml
├─ README.md
├─ DECISIONS.md             # log any departures from this spec
├─ SPEC.md                  # this file
└─ LICENSE                  # MIT
```

---

## 11. Security (non-negotiable)

- **Verify every interaction** with Discord's Ed25519 signature. Reject anything invalid with `401`.
- **Allow-list repliers** (`ALLOWED_USER_IDS`). Replies are public and published under the developer's name, so a random server member must never be able to post one.
- **Secrets only via `wrangler secret`.** Never commit them, never log them, never echo token values in errors.
- **Least privilege:** the README instructs granting the service account **only** the app(s) needed and the "Reply to reviews" permission plus view access, not Admin.
- **Don't log full review text at info level.** Log review IDs, not content.
- **Privacy note in README:** review data is stored in the user's own D1 database; nothing is sent anywhere else.

---

## 12. Error handling and observability

- **Google token failures / 401 / 403:** post **one** warning message to the channel (deduplicated; don't spam every 15 minutes) with a pointer to the setup docs, and log it. Clear the warning state once it works again.
- **Play 429 / 5xx:** back off and skip this cycle; the next cron picks up where it left off (the 7-day window is forgiving).
- **Discord 429:** respect `Retry-After`. If the cron is running out of time, stop posting and leave the rest for the next run (unposted reviews stay pending in D1).
- **Message deleted in Discord:** if editing fails with 404, post a fresh message instead.
- **Structured logs** (`console.log(JSON.stringify(...))`) with `event`, `appId`, `reviewId`, `durationMs`, readable via `wrangler tail`.
- `/reviews status` (v1.1) or the startup message shows last successful poll time.

---

## 13. Testing

- **Unit tests (Vitest)** for everything in `core/`: normalisation (title/tab split, missing optional fields, translated text), diff cases (new, edited, rating changed, replied elsewhere, reply edited), digest maths.
- **Fixtures** from realistic API responses, including: no `authorName`, no `deviceMetadata`, translated review, review with existing developer reply, multi-page result.
- **Signature verification tests** with known-good and tampered payloads.
- **Integration (Workers test pool or Miniflare):** cron run against mocked Google and Discord endpoints, asserting D1 state and outbound calls.
- **Manual end-to-end with `DRY_RUN=true`** on Lune first, then one real reply.

---

## 14. README outline (part of the deliverable)

The README is the product for an open-source tool. It should take someone from zero to working in under 15 minutes.
1. What it does (one GIF: new review appears → Reply → modal → reply shows as published).
2. Requirements: Cloudflare account, Discord server admin, Play Console admin access.
3. Setup:
   1. Google Cloud: enable API, create service account and JSON key.
   2. Play Console: invite the service account with "Reply to reviews" (+ view) for your app. Note that permissions can take time to propagate.
   3. Discord: create the application and bot, copy token, public key and application ID, invite the bot to your server with "Send Messages" and "Embed Links", copy the channel ID, and find your user ID for the allow-list.
   4. Deploy: clone, `npm i`, create D1 + apply schema, set vars and secrets, `wrangler deploy`.
   5. Set the Interactions Endpoint URL in the Discord app to `https://<worker>/interactions`.
   6. Wait for the "Connected ✓" message.
4. Configuration reference (table from §9).
5. Limitations, stated honestly: written reviews only, production only, 7-day API window.
6. Troubleshooting: permission denied, no messages, interaction failed.
7. Privacy and security notes.

---

## 15. Milestones (≈ 1 week)

| Day | Deliverable |
|---|---|
| 1 | Repo scaffold, config validation, Play auth via WebCrypto, `listReviews` with pagination working against Lune (log output only). |
| 2 | Normalise + D1 schema + diff logic, with unit tests. First-run backfill modes. |
| 3 | Discord posting (embeds, colours, buttons), 429 handling, "Connected" message. Cron live on Lune. |
| 4 | Interactions endpoint: signature verification, allow-list, Reply modal, deferred reply → Play API → message update. `DRY_RUN`. |
| 5 | Edited reviews, replied-elsewhere detection, Edit reply flow, error messages, deduplicated warnings. |
| 6 | Weekly digest. Integration tests. |
| 7 | README with GIF, LICENSE, DECISIONS.md, polish, tag `v1.0.0`. |

If behind schedule, cut in this order: digest → edited-review polish → backfill modes (keep `silent`). **Never cut:** signature verification, allow-list, the reply flow itself.

---

## 16. Roadmap after v1 (don't build now; keep the design open to it)

- **v1.1:** slash commands (`unanswered`, `digest`, `status`); per-app channels; Telegram notifier via the same `Notifier` interface (reply with force-reply messages).
- **v2: AI drafts (human-approved).** A "Draft reply" button produces a suggestion in the developer's tone (style examples in config) that pre-fills the modal. The user edits and submits. Bring-your-own API key. Never auto-post.
- **v2: tagging.** Classify reviews as bug / feature request / praise / billing / other, and show that in the digest.
- **v2: App Store Connect reviews** (iOS) through the same normalised `Review` type.
- **v3: insights.** Cluster recurring complaints, link review spikes to app versions, alert on rating drops, add "Create GitHub issue" from a review, and "notify reporters when fixed" (reply to everyone who reported a bug once a fix ships).
- **Maybe:** Android vitals (crash/ANR) next to reviews.

---

## 17. Decisions: fixed vs. flexible

**Fixed unless the owner says otherwise**
- Single Cloudflare Worker, free tier, self-hosted.
- Discord first.
- Human-approved replies only; allow-listed repliers; signature verification.
- Normalised internal `Review` type, with Play specifics isolated in `play/`.
- MIT, open source.

**Flexible: improve freely and log it in DECISIONS.md**
- D1 vs KV (or both), table shapes, indexes.
- Library choices (e.g., `discord-interactions` vs hand-rolled verification; a tiny JWT helper vs hand-rolled).
- Message design, wording, colours, field order.
- Poll interval (5–30 minutes is reasonable within quota).
- How idempotency is achieved.
- File and module names (keep the boundaries in §6).
- Digest contents.

---

## 18. Open questions (decide during the build)

1. **Name.** Something short and memorable for an npm/GitHub repo under fusionfroze. Check availability before deciding.
2. Should edited reviews post a new message (current recommendation) or edit the original in place? Try both on real data and keep whichever reads better.
3. Thread-per-review (Discord threads) vs flat channel? Threads keep discussion tidy for teams; flat is simpler. Default flat.
4. Is a CLI setup helper (`npx <name> init` to create D1, set secrets and print the URLs) worth it for v1, or README-only? Recommend README-only for v1, CLI in v1.1 if people struggle.

---

## 19. Definition of done (v1)

- [ ] A new written Lune review appears in Discord within 15 minutes, formatted per §8.3.
- [ ] Reply from Discord publishes on Google Play and the message updates to show it.
- [ ] Non-allow-listed users cannot reply; invalid signatures are rejected.
- [ ] Edited reviews and replies made in Play Console are reflected without duplicates.
- [ ] Weekly digest posts on schedule.
- [ ] Runs a week on Lune with no manual intervention and no errors in `wrangler tail`.
- [ ] Core logic unit-tested; README lets a fresh user deploy in under 15 minutes.
- [ ] Tagged `v1.0.0`, MIT licensed, public on GitHub.

---

## 20. Launch checklist (after v1, short)

- 20-second screen recording: real review arrives → reply from Discord → shows on Play.
- Post on X (build-in-public), r/androiddev, r/reactnative, r/expo, and a Show HN.
- PR to relevant awesome lists (Android tooling, Discord bots).
- Pin a "use this template / deploy" section at the top of the README.
