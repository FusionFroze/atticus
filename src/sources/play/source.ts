import type { Review } from "../../core/review";
import { log } from "../../lib/log";
import type { ReviewSource } from "../types";
import { type GoogleCredentials, getAccessToken } from "./auth";
import { listReviews, reply as postReply } from "./client";
import { normalizeReview } from "./normalize";

// `reply` is the Play client's reply, so the interface is real. Nothing calls it until v1-4.
// `review_malformed` carries the app id, the review id and the skip reason, never the text.
export function createPlaySource(input: {
  google: GoogleCredentials;
  translationLanguage: string | null;
}): ReviewSource {
  return {
    store: "play",

    async listRecent(app, budget) {
      const token = await getAccessToken(input.google, budget);
      if (!token.ok) return { ok: false, failure: token.failure };

      const listed = await listReviews({
        packageName: app.id,
        translationLanguage: input.translationLanguage,
        accessToken: token.token,
        budget,
      });
      if (!listed.ok) return listed;

      const reviews: Review[] = [];
      for (const raw of listed.reviews) {
        const normalized = normalizeReview(app.id, raw);
        if ("reason" in normalized) {
          log("review_malformed", {
            appId: app.id,
            reviewId: normalized.reviewId,
            reason: normalized.reason,
          });
          continue;
        }
        reviews.push(normalized);
      }
      return { ok: true, reviews, truncated: listed.truncated };
    },

    async reply(app, reviewId, text, budget) {
      const token = await getAccessToken(input.google, budget);
      if (!token.ok) return { ok: false, failure: token.failure };
      return postReply({
        packageName: app.id,
        reviewId,
        text,
        accessToken: token.token,
        budget,
      });
    },
  };
}
