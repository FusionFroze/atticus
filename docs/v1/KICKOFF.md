# Kickoff prompts for v1-2 … v1-8

Paste one into a **new** chat per chunk. Each starts with the chunk's own kickoff block (from the top of `chunks/v1-N.md`), then the same working rules, then that chunk's stages. The rules carry what v1-1 changed: tests stub `fetch` instead of using `fetchMock`, test secrets are placeholders, and CPU time comes from `wrangler tail --format json`.

The chat stops at each ⏸ and waits for you. Read every plan before saying go, and audit each chunk in a fresh chat before committing it.

---

## v1-2 — Normalise, store, diff, outbox

```text
Implement chunk v1-2 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-2.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production. Never publish a real Play reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md if a decision changed, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(2): …`.

Stages:
0. The BACKFILL=summary open item: ask me, with your recommendation. ⏸ Also ask: the production D1 database `atticus` doesn't exist yet (it's created in v1-7). Do we create it now for the top-level binding, or leave the top-level binding out until v1-7? Recommend one.
1. src/sources/types.ts: ReviewSource and ListResult. src/sources/play/normalize.ts and its fixture tests (add fixtures for every SPEC §13 case). listRecent returns Review[].
2. migrations/0001_init.sql, the D1 binding in wrangler.jsonc, the db:migrate* scripts. Local D1 in tests through the plugin's migration helper.
3. src/store/: every named function in the brief, multi-row writes in batch(). Unit or integration tests per function.
4. src/core/diff.ts: V32's table as a pure function, one test per row. ⏸ Show me the outcome table you implemented.
5. src/jobs/poll.ts under the lease, plus first-run handling. index.ts calls it (listing moves out of index.ts).
6. The integration tests the brief lists, every one. ⏸
7. The dev Worker: `npx wrangler d1 create atticus-dev`, put its id in env.dev, `npm run db:migrate:dev`, `npm run deploy:dev`. The secrets are already set on atticus-dev; don't re-upload them. After two cron runs, query counts only. Lune may have 0 reviews in the window: then expect app_seen set and one connected row with count 0. ⏸
```

## v1-3 — Discord notifier, sender, the look

```text
Implement chunk v1-3 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-3.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production. Never publish a real Play reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md if a decision changed, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(3): …`.

Stages:
0. Check the Discord owner setup with me. I give you the dev application id, public key, test channel id and my user id; they go in wrangler.jsonc env.dev vars. The bot token is a secret: I set it myself with `npx wrangler secret put DISCORD_BOT_TOKEN --env dev` and in .dev.vars. Never ask me to paste it in chat. discord-api-types 0.38.56 is already approved, types only. ⏸
1. src/notifiers/types.ts (lock the method list with me) and src/notifiers/discord/client.ts, with tests for every status mapping, the nonce and allowed_mentions.
2. src/notifiers/discord/render.ts: classic embeds AND Components V2, pure, with every limit and edge case the brief lists tested.
3. src/jobs/send.ts plus the integration tests the brief lists (nonce on retry, 429, 500 backoff, 400, budget, a 200-review backfill within 45 calls per run). ⏸
4. The look: ask before resetting the dev D1. Then post both formats of the same real reviews to the test channel and ask me one question at a time. I check desktop and mobile, light and dark. ⏸ after each round.
5. Remove the losing format, lock the values and the v1-3 Copy rows with me, then the verify steps (the ping test to my own id, the @everyone test, CPU and calls per run). ⏸
```

## v1-4 — Interactions and the reply flow

```text
Implement chunk v1-4 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-4.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production. Never publish a real Play reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md if a decision changed, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(4): …`.

This chunk is security-critical and never cut. Take the time it needs.

Stages:
0. The replay-window open item: ask me, with your recommendation. ⏸
1. src/notifiers/discord/verify.ts with every test the brief lists (key pairs generated in the test). Signature check before any JSON parsing.
2. src/notifiers/discord/interactions.ts: routing, PING, the allow-list, the channel check, the modal (a Label wrapping the Text Input, 350 max, prefilled for Edit reply). fetch() routes only POST /interactions.
3. src/jobs/reply.ts (platform-agnostic) and the submit path: defer, then waitUntil, then the webhook edit, with ephemeral follow-ups on failure. No automatic retry of the Play POST.
4. Every integration test the brief lists. ⏸ Show me the list of paths covered.
5. Deploy dev. I set the Interactions Endpoint URL in the Discord portal myself. Then the dry-run checks with me in the test channel, the modal and replied-message look one question at a time, and the v1-4 Copy locked. ⏸
6. One real reply: I pick the review and approve the exact text in this chat. Only then set DRY_RUN=false on dev, publish that one reply, and set DRY_RUN back to true straight after. Never do this without both approvals. ⏸
7. CPU for a click and a submit, plus the Signature, Allow-list and Clean-logs smokes. ⏸
```

## v1-5 — Edits, external replies, health

```text
Implement chunk v1-5 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-5.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production. Never publish a real Play reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md if a decision changed, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(5): …`.

Stages:
0. The edited-review form: show me both options on the dev Worker with a fixture edit, (a) a new message replying to the original and (b) an in-place edit. I pick. If (b) wins, record a deviation against V42. Then the Reply vs Edit reply rule after an edit: ask me. ⏸
1. review_edited and message_update rendering, and the diff and render unit tests.
2. Deleted-message reposting (V61) and the warnings (V60): raised once, cleared once.
3. Every integration test the brief lists. ⏸
4. On dev, with me: the v1-5 Copy locked, then a deleted test message (I delete it) reposted, and a forced 403 from a fake package added to the dev APPS. Remove it afterwards and check for the one recovery message. Ask whether I'm willing to make a real external reply in Play Console; if not, rely on the tests. ⏸
```

## v1-6 — Weekly digest

```text
Implement chunk v1-6 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-6.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production. Never publish a real Play reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md if a decision changed, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(6): …`.

Stages:
0. The two open items (one digest per app or combined; what a quiet week posts): ask me, with recommendations. ⏸
1. src/core/time.ts with every DST and lateness test the brief lists.
2. src/core/digest.ts (pure stats) with tests for each figure, empty weeks, one review and ties.
3. The store queries, src/jobs/digest.ts and the integration tests. ⏸
4. The look in the test channel, one question at a time, and the v1-6 Copy locked. ⏸
5. On dev: set DIGEST_DAY/DIGEST_HOUR to just past now, check it posts once, then put the values back. Hand-check one digest's numbers against a D1 query, counts only. ⏸
```

## v1-7 — Hardening, README, production

```text
Implement chunk v1-7 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-7.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first, no code: files to add or change, the functions and their signatures, the tests, your questions for me, and anything where the docs disagree with the code at HEAD or the current platform docs. ⏸ Wait for my go-ahead.
- Build in the stages below. After every stage `npm run check` must be green; give me a 3-line summary. Stop and wait at each ⏸.
- Ask before: any dependency, any user-facing string, any choice the docs don't settle (2–3 options, your recommendation), any commit.
- Never print, log or commit a secret, token, review text, author name or reply text. Never post to production except through the README run-through I'm watching. Never publish a real Play reply without my go-ahead for that specific reply.
- v1-1 changed the test setup: tests use @cloudflare/vitest-plugin and stub globalThis.fetch (there is no fetchMock, so read "fetchMock" in the brief as a fetch stub). Secret bindings in tests are placeholders in vitest.config.ts; a new secret gets one too.
- CPU numbers come from `npx wrangler tail --env dev --format json` (the cpuTime field, in ms).
- Finish: the chunk log entry, DECISIONS.md final, ARCHITECTURE.md if the structure changed. Then ask me to commit as `v1(7): …`.

Stages:
0. Check the owner setup with me: the production Atticus Discord app, `gh auth login`, the private repo fusionfroze/atticus. Then list every "not run", "not measured" or "needs checking" note from all chunk logs, and how you'll close each. ⏸
1. The full end-to-end integration test (two apps, a backfill, an edit, an external reply, a warning, a due digest, ≤ 45 calls per run). Then every V1.md smoke, each ticked or explained. ⏸
2. README.md per SPEC §14. Every section a warning links to must exist under exactly that name. Plus LICENSE (MIT, FusionFroze, 2026), DECISIONS.md and .dev.vars.example made final. ⏸
3. The production run-through: I follow the README from a clean start while you watch and time it. Each stumble becomes a README fix. Production uses its own D1 database and Discord app, and Lune's real channel. Nothing from tests is ever posted there. ⏸
4. The tagline confirmed and set as the repo description. Push to the private repo only after my go-ahead. Log the date the dogfood week starts. ⏸
```

## v1-8 — Release v1.0.0 (only after a week on Lune)

```text
Implement chunk v1-8 of Atticus v1.
Read docs/v1/V1.md in full, then docs/ARCHITECTURE.md, then docs/v1/chunks/v1-8.md, then every file that chunk lists under "Read first".
git log --oneline. Follow that chunk contract exactly. Stop when it's done and append to the chunk log in docs/v1/V1.md.

How to work:
- Plan first: the release steps, the evidence you'll collect for each SPEC §19 box, and your questions for me. ⏸ Wait for my go-ahead.
- Stop and wait at each ⏸. Ask before any dependency (including running a tool through npx), any user-facing string, any choice the docs don't settle, any commit, push, tag or visibility change.
- Never print, log or commit a secret, token, review text, author name or reply text.
- Finish: the chunk log entry, then ask me to commit as `v1(8): …`.

Stages:
0. Check the dogfood week really happened (the start date is in v1-7's log). Then review the week's logs with me; anything that isn't small to fix is a stop and a question. ⏸
1. SPEC §19, every box, with evidence in the log.
2. The secrets scan of the full git history. Propose the tool and ask before running it. Anything found means stop, and we plan the history rewrite before anything goes public. ⏸
3. The final docs: I record the GIF. No "proposed" Copy rows left for shipped features. A Roadmap section for what moves to v1.1. package.json and the User-Agent at 1.0.0. ⏸
4. Only with my explicit go-ahead: make the repo public, set the description, push tag v1.0.0, create the GitHub release. Then give me SPEC §20's launch list; you don't post anywhere. ⏸
```
