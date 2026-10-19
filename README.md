# Atticus

Get your Google Play reviews in Discord and reply from chat. One free Cloudflare Worker, self-hosted.

<!-- Demo GIF (v1-8): a new review arrives → Reply → the modal → the reply shows as published. -->

## What it does

- Every 15 minutes, Atticus checks Google Play for new and edited written reviews and posts each one to a Discord channel: stars, text, app version, device, and a translation when you ask for one.
- People on your allow-list click **Reply**, type in a modal, and the reply is published on Google Play under your developer name. The message updates to show it.
- Replies made in Play Console, edited reviews and changed ratings show up in Discord too, without duplicate posts.
- Once a week it posts a short digest per app: new and edited reviews, the average, the star spread, the reply rate and the lowest-rated reviews still waiting for an answer.
- It runs as one Cloudflare Worker with one D1 database on the free plan. Your keys and your reviews stay in your own accounts.

## Requirements

- A **Cloudflare** account. The free plan is enough.
- A **Google Play Console** account with admin access to the app, and a **Google Cloud** project to create a service account in.
- A **Discord** server where you can add a bot (Manage Server).
- **Node.js 24** or later, and git.

Setup takes about 15 minutes. Google can take up to a day to apply the service account's permissions, so start with Google setup.

## Setup

### Google setup

**In Google Cloud** (console.cloud.google.com):

1. Create a project, or pick an existing one.
2. Go to **APIs & Services → Library**, search for **Google Play Android Developer API**, and click **Enable**.
3. Go to **IAM & Admin → Service Accounts → Create service account**. Give it a name such as `atticus`. It needs no Google Cloud roles, so skip that step.
4. Open the new service account, then **Keys → Add key → Create new key → JSON**. A `.json` file downloads. Keep it outside the Atticus folder, and never commit it. You'll need it in Deploy.

**In Play Console** (play.google.com/console):

1. Go to **Users and permissions → Invite new users**.
2. For the email address, paste the service account's `client_email` from the JSON file. It ends in `.iam.gserviceaccount.com`.
3. Under **App permissions**, add only the app (or apps) Atticus should watch. Grant **Reply to reviews** and the read-only **View app information** permission. Don't grant account-wide or admin permissions.
4. Click **Invite user**.

> **New permissions can take up to a day to apply.** Until then Atticus posts a "doesn't have permission" warning in your channel. It clears itself, with a "Back to normal" message, the first time Google lets it read your reviews.

### Discord setup

1. Go to discord.com/developers/applications and click **New Application**. Name it **Atticus** (or anything you like).
2. On **General Information**, copy the **Application ID** and the **Public Key**. Both go in `wrangler.jsonc`.
3. On **Bot**, click **Reset Token** and copy the token. It's shown once. This is the `DISCORD_BOT_TOKEN` secret. Turn off **Public Bot**, so only you can add it to servers. If Discord says a private application can't have a default authorization link, first set **Installation → Install Link** to **None**. Atticus needs no privileged intents.
4. Invite the bot to your server by opening this URL, with your Application ID in place of `APPLICATION_ID`:

   ```
   https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&scope=bot&permissions=68608
   ```

   That grants **View Channel**, **Send Messages** and **Read Message History**. Read Message History is needed because an edited review is posted as a reply to the earlier message. If the reviews channel is private, add the bot to it with those three permissions.
5. In Discord, turn on **User Settings → Advanced → Developer Mode**. Then right-click the reviews channel and choose **Copy Channel ID**, and right-click your own name and choose **Copy User ID**. Do the same for everyone who should be able to reply.

### Deploy

```sh
git clone https://github.com/fusionfroze/atticus.git
cd atticus
npm i
npx wrangler login
npx wrangler d1 create atticus
```

`d1 create` prints a `database_id`. Open `wrangler.jsonc` and replace every `REPLACE_WITH_…` value:

- `d1_databases[0].database_id`: the id from `d1 create`.
- `APPS`: your app's package name (for example `com.example.app`) and the name to show in messages. `consoleUrl` is optional: the address of the app's **Ratings and reviews** page in Play Console, for an "Open in Play Console" button.
- `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`: from Discord setup, step 2.
- `DISCORD_CHANNEL_ID`: the reviews channel.
- `ALLOWED_USER_IDS`: your user id, plus anyone else who may reply, separated by commas.
- `TIMEZONE`: your IANA time zone, such as `Europe/Berlin`. The weekly digest uses it.

Ignore the `env.dev` block at the bottom. It is the maintainers' test Worker.

Then create the tables and deploy:

```sh
npm run db:migrate
npm run deploy
```

On a new Cloudflare account, the first deploy asks you to pick a `workers.dev` subdomain. Note the URL it prints, such as `https://atticus.<your-subdomain>.workers.dev`.

Finally, add the two secrets. The Google key is read from its file. The bot token is pasted when asked.

```sh
# macOS, Linux, Git Bash or cmd
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON < path/to/your-key.json

# PowerShell
Get-Content path\to\your-key.json -Raw | npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON

npx wrangler secret put DISCORD_BOT_TOKEN
```

Secrets only ever go in this way. Never put them in `wrangler.jsonc`.

### Interactions Endpoint URL

In the Discord developer portal, open your application's **General Information** page. Set **Interactions Endpoint URL** to your Worker's URL plus `/interactions`:

```
https://atticus.<your-subdomain>.workers.dev/interactions
```

Click **Save Changes**. Discord checks the URL straight away. If it refuses, the `DISCORD_PUBLIC_KEY` in `wrangler.jsonc` doesn't match this application, or the latest deploy hasn't finished.

### The Connected message

Within 15 minutes, Atticus posts **Connected to {your app} ✓** in your channel, with the number of written reviews it found from the last 7 days. With the default `BACKFILL=post`, those reviews follow, oldest first. A large backlog is posted over a few runs.

If nothing appears after 20 minutes, see [No messages](#no-messages).

## Configuration

Settings live in `wrangler.jsonc` → `vars`, except the two secrets. After changing a var, run `npm run deploy`.

**`APPS`** (required): a JSON list with one entry per app.

| Field | Required | Notes |
| --- | --- | --- |
| `store` | ✓ | `"play"`, the only store in v1. |
| `id` | ✓ | The package name. Each app once. |
| `name` | | Shown in messages and the digest. Defaults to `id`. |
| `consoleUrl` | | An `https://` link to the app in Play Console, for the "Open in Play Console" button. No button when unset. |

Unknown fields are an error, so a typo such as `consoleURL` is caught.

**Everything else:**

| Name | Kind | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | ✓ | | The whole JSON key file. Only `client_email` and `private_key` are read. |
| `DISCORD_BOT_TOKEN` | secret | ✓ | | From the Bot page. |
| `DISCORD_APPLICATION_ID` | var | ✓ | | 17–20 digits. |
| `DISCORD_PUBLIC_KEY` | var | ✓ | | 64 hex characters. Public, so it's a var. |
| `DISCORD_CHANNEL_ID` | var | ✓ | | Where everything is posted. |
| `ALLOWED_USER_IDS` | var | ✓ | | Discord user ids allowed to reply, comma-separated. It can't be empty: nobody replies by default. |
| `TRANSLATION_LANGUAGE` | var | | unset | A language code such as `en`. Reviews in other languages are shown translated, with the original below. |
| `BACKFILL` | var | | `post` | What to do with the reviews found on the first run: `post` them, or `silent` (save them, post only new ones). |
| `PING_ON_LOW_RATING` | var | | unset | Mention someone on 1–2★ reviews: a user id, or `&` plus a role id. Nothing else ever pings. |
| `TIMEZONE` | var | | `UTC` | An IANA name such as `Asia/Kolkata`. |
| `DIGEST_ENABLED` | var | | `true` | `true` or `false`. |
| `DIGEST_DAY` | var | | `mon` | `mon` … `sun`. |
| `DIGEST_HOUR` | var | | `9` | `0` … `23`, in `TIMEZONE`. |
| `DRY_RUN` | var | | `false` | `true` shows replies in Discord without publishing them on Google Play. |

The check runs every 15 minutes. To change that, edit `triggers.crons` in `wrangler.jsonc`.

## Limitations

These come from Google's API and the free plan.

- **Written reviews only.** Star ratings without text aren't available through the API, so the digest's numbers aren't your store rating.
- **Production only.** Feedback from testing tracks isn't included.
- **A 7-day window.** Google only returns reviews created or edited in the last 7 days. If Atticus is stopped for longer than that, changes in between are missed.
- **Deleted reviews look like old ones.** When a review disappears from the API, Atticus can't tell whether the author deleted it or it simply aged out of the window, so its message stays as it is.
- **Not instant.** A new review shows up within about 15 minutes of Google listing it. A first run with a large backlog, or a burst of reviews, is posted over several runs (about 40 messages per run).
- **Replies are plain text, up to 350 characters**, Google's limit.
- **CPU time.** A check uses about 10–20 ms of CPU, around the free plan's 10 ms guideline. Cloudflare tolerated this in testing, with no runs stopped. Cloudflare's dashboard shows any that are, under **Exceeded CPU Time Limits**.

## Troubleshooting

To see what Atticus is doing, run `npx wrangler tail` in the Atticus folder and wait for the next check. Logs show event names, ids and statuses. They never contain review text, names, replies or keys.

### Permission denied

The channel shows "Atticus doesn't have permission to read reviews for {app}".

- If you invited the service account recently, wait. Permissions can take up to a day to apply, and the warning clears itself.
- In Play Console → **Users and permissions**, check the service account is listed and has access to that app, with **Reply to reviews** and **View app information**.
- Check the package name in `APPS` matches the app exactly.

### Google sign-in

The channel shows "Atticus can't sign in to Google".

- The key may have been deleted or rotated in Google Cloud. Create a new JSON key and put it again with `npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON`, as in [Deploy](#deploy).
- Check the **Google Play Android Developer API** is enabled in the same Google Cloud project as the service account.

### No messages

- Run `npx wrangler tail` and wait for the next check (on the quarter hour).
  - **`config_invalid`:** see [Config errors in wrangler tail](#config-errors-in-wrangler-tail).
  - **`warning_raised` with `discord_channel`, or `send_stopped` with `channel`:** Discord refused the channel. Check `DISCORD_CHANNEL_ID`, and that the bot can see that channel, post in it and read its history.
  - **`send_stopped` with `unauthorized`:** the bot token is wrong. Reset it on the Bot page and put it again with `npx wrangler secret put DISCORD_BOT_TOKEN`.
  - **`poll_app` with `count` 0:** Google has no written reviews from the last 7 days. The Connected message still says so.
- In the Cloudflare dashboard, check the Worker has a cron trigger, `*/15 * * * *`. `npm run deploy` sets it.

### "This interaction failed"

Discord shows this when the Worker didn't answer a button or a modal.

- Check the **Interactions Endpoint URL** ends in `/interactions` and points at this Worker.
- If config is invalid, the Worker answers with an error. See [Config errors in wrangler tail](#config-errors-in-wrangler-tail).
- If you get "Only people on this bot's allow-list can reply to reviews", add your user id to `ALLOWED_USER_IDS` and deploy again.
- Buttons only work in `DISCORD_CHANNEL_ID`, and only on messages from this deployment.

### Config errors in wrangler tail

When config is wrong, every check logs one `config_invalid` event listing every problem at once, and does nothing else. Each line names the setting and where to fix it, for example:

```
`DISCORD_CHANNEL_ID` must be a Discord snowflake (17-20 digits). Set it in wrangler.jsonc → vars (README → Discord setup).
```

Fix them all, run `npm run deploy` (or `wrangler secret put` for a secret), and wait for the next check. Error messages never include a secret's value.

## Privacy and security

- **Your data stays with you.** Reviews are stored only in your own D1 database and posted only to your channel. Atticus sends nothing anywhere else, and nobody else runs it for you.
- **Secrets only via `wrangler secret`.** The Google key and the bot token are never in `wrangler.jsonc`, never in git and never in logs. The Google access token is kept in memory only.
- **Every Discord request is verified.** The Worker checks Discord's Ed25519 signature before reading anything, and rejects stale timestamps.
- **Only allow-listed people can reply,** and only in your configured channel. Replies are public under your developer name, so keep the list short.
- **Least privilege.** The service account needs only **Reply to reviews** and read-only access, for the apps you choose.
- **Humans write every reply.** Atticus never writes, suggests or posts a reply on its own.
- **No surprise pings.** A review containing `@everyone` pings nobody. Only `PING_ON_LOW_RATING` can mention anyone.
- **Logs carry ids and statuses only,** never review text, names, replies or keys.

## Upgrading

Commit your `wrangler.jsonc` in your clone first, so `git pull` can merge new changes into it:

```sh
git commit -am "My Atticus config"
git pull
npm i
npm run db:migrate
npm run deploy
```

`db:migrate` applies only the new database migrations. When there are none, it says so.

## License

[MIT](LICENSE). The design decisions are in [DECISIONS.md](DECISIONS.md).
