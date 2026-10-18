import { parseConfig } from "./config/parse";
import type { Env } from "./env";
import { createBudget } from "./lib/budget";
import { type LogValue, log } from "./lib/log";
import { getAccessToken } from "./sources/play/auth";
import { listReviews } from "./sources/play/client";
import type { SourceFailure } from "./sources/types";

function failureFields(failure: SourceFailure): Record<string, LogValue> {
  if (failure.kind === "unavailable")
    return { kind: failure.kind, status: failure.status };
  if (failure.kind === "invalid")
    return { kind: failure.kind, detail: failure.detail };
  return { kind: failure.kind };
}

export default {
  async scheduled(_controller, env, _ctx): Promise<void> {
    const parsed = parseConfig(env);
    if (!parsed.ok) {
      log("config_invalid", { errors: parsed.errors });
      return;
    }

    const budget = createBudget(Date.now());
    const token = await getAccessToken(parsed.config.google, budget);
    if (!token.ok) {
      log("poll_failed", failureFields(token.failure));
      if (token.failure.kind === "budget") log("budget_exhausted");
      return;
    }

    for (const app of parsed.config.apps) {
      const result = await listReviews({
        packageName: app.id,
        translationLanguage: parsed.config.translationLanguage,
        accessToken: token.token,
        budget,
      });
      if (!result.ok) {
        log("poll_failed", { appId: app.id, ...failureFields(result.failure) });
        if (result.failure.kind === "budget") {
          log("budget_exhausted");
          break;
        }
        continue;
      }
      if (result.truncated) log("poll_truncated", { appId: app.id });
      log("poll_app", {
        appId: app.id,
        count: result.reviews.length,
        reviewIds: result.reviews.map((review) => review.reviewId),
      });
    }
  },

  async fetch(_request, _env, _ctx): Promise<Response> {
    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
