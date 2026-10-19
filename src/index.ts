import { parseConfig } from "./config/parse";
import type { Env } from "./env";
import { poll } from "./jobs/poll";
import { send } from "./jobs/send";
import { createBudget } from "./lib/budget";
import { log } from "./lib/log";
import { createDiscordClient } from "./notifiers/discord/client";
import { handleInteraction } from "./notifiers/discord/interactions";
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

  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response(null, { status: 404 });
    }
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      log("config_invalid", { errors: parsed.errors });
      return new Response("Internal Server Error", { status: 500 });
    }
    const nowMs = Date.now();
    const config = parsed.config;
    return handleInteraction({
      request,
      config,
      db: env.DB,
      source: createPlaySource({
        google: config.google,
        translationLanguage: config.translationLanguage,
      }),
      budget: createBudget(nowMs),
      waitUntil: (work) => {
        ctx.waitUntil(work);
      },
      nowMs,
    });
  },
} satisfies ExportedHandler<Env>;
