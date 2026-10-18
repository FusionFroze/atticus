# Atticus

Atticus is a self-hosted Cloudflare Worker that posts Google Play reviews to Discord and lets allow-listed people reply from Discord. `SPEC.md` is the vision. `docs/ARCHITECTURE.md` is how it's built, and holds for every change.

# Always

- Read `docs/ARCHITECTURE.md` before writing code. Keep its module boundaries and its dependency rule.
- No runtime dependencies. Adding any dependency, dev or runtime, needs the owner's yes.
- Never log, print or commit a secret, a token, review text, an author's name or reply text. `.dev.vars` stays out of git; check `git status` before every commit.
- Never publish a real reply on Google Play without the owner's go-ahead for that reply. Never post to the production channel from a test.
- When a choice isn't settled by the docs, explain the options, recommend one and ask. Don't decide alone.
- Ask before committing. Never create a branch without asking.
- Re-verify platform facts (Google Play, Discord, Cloudflare) against their current docs before relying on them.

# Atticus v1

When implementing or reviewing anything in v1 (the scaffold, config, Play polling, the D1 store and outbox, Discord messages, the interactions endpoint and reply flow, edited reviews and external replies, health warnings, the weekly digest, the README or the release), follow `docs/v1/V1.md` exactly. Decisions in that file are frozen. It is a delta against `SPEC.md`: where it decides, it supersedes the spec. Work on `main`. Read it in full, then `docs/ARCHITECTURE.md`, then the chunk brief `docs/v1/chunks/v1-N.md` you were given, and every file that brief lists under "Read first", before writing any code. Implement only that chunk, and append to the chunk log in `docs/v1/V1.md` when it lands. Message looks are iterated with the owner on real messages in the Discord test channel. Anything touching interactions, posting or logging must pass the standing smokes in `docs/ARCHITECTURE.md`.
