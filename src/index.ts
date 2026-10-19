import { parseConfig } from "./config/parse";
import type { Env } from "./env";
import { poll } from "./jobs/poll";
import { send } from "./jobs/send";
import { createBudget } from "./lib/budget";
import { log } from "./lib/log";
import { createDiscordClient } from "./notifiers/discord/client";
import { createDiscordNotifier } from "./notifiers/discord/notifier";
import { createPlaySource } from "./sources/play/source";

export default {
  async scheduled(_controller, env, _ctx): Promise<void> {
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      log("config_invalid", { errors: parsed.errors });
      return;
    }

    const nowMs = Date.now();
    const budget = createBudget(nowMs);
    const config = parsed.config;
    const notifier = createDiscordNotifier({
      client: createDiscordClient({
        botToken: config.discord.botToken,
        budget,
      }),
      channelId: config.discord.channelId,
    });
    await poll({
      db: env.DB,
      config,
      source: createPlaySource({
        google: config.google,
        translationLanguage: config.translationLanguage,
      }),
      budget,
      nowMs,
      afterApps: () => send({ db: env.DB, config, notifier, budget, nowMs }),
    });
  },

  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
