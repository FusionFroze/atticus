import { parseConfig } from "./config/parse";
import type { Env } from "./env";
import { poll } from "./jobs/poll";
import { createBudget } from "./lib/budget";
import { log } from "./lib/log";
import { createPlaySource } from "./sources/play/source";

export default {
  async scheduled(_controller, env, _ctx): Promise<void> {
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      log("config_invalid", { errors: parsed.errors });
      return;
    }

    const nowMs = Date.now();
    await poll({
      db: env.DB,
      config: parsed.config,
      source: createPlaySource({
        google: parsed.config.google,
        translationLanguage: parsed.config.translationLanguage,
      }),
      budget: createBudget(nowMs),
      nowMs,
    });
  },

  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
