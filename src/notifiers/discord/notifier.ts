import type { Notifier } from "../types";
import type { DiscordClient } from "./client";
import { renderDigest, renderNotice, renderReview } from "./render";

export function createDiscordNotifier(input: {
  client: DiscordClient;
  channelId: string;
}): Notifier {
  return {
    postReview(review, nonce) {
      return input.client.createMessage(
        input.channelId,
        renderReview(review),
        nonce,
      );
    },
    updateReview(ref, review) {
      return input.client.editMessage(ref, renderReview(review));
    },
    postNotice(notice, nonce) {
      return input.client.createMessage(
        input.channelId,
        renderNotice(notice),
        nonce,
      );
    },
    postDigest(digest, nonce) {
      return input.client.createMessage(
        input.channelId,
        renderDigest(digest),
        nonce,
      );
    },
  };
}
