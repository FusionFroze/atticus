import { log } from "../../lib/log";
import type { DigestInput, MessageRef, Notifier, SendFailure } from "../types";
import type { DiscordClient } from "./client";
import { supersededLine } from "./copy";
import { COMPONENTS_V2 } from "./parts";
import { renderDigest, renderNotice, renderReview } from "./render";
import { supersedeComponents } from "./supersede";

export function createDiscordNotifier(input: {
  client: DiscordClient;
  channelId: string;
}): Notifier {
  return {
    async postReview(review, nonce, previous) {
      const body = renderReview(review);
      if (previous != null) {
        body.messageReference = {
          messageId: previous.messageId,
          failIfNotExists: false,
        };
      }
      const created = await input.client.createMessage(
        input.channelId,
        body,
        nonce,
      );
      if (!created.ok || previous == null) return created;
      const patched = await pointAtNewer(
        input.client,
        previous,
        pointer(created.ref, input.channelId),
      );
      if (patched !== null) return patched;
      return created;
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
    async postDigest(digest, nonce) {
      const resolved = await withGuild(input.client, input.channelId, digest);
      if (!resolved.ok) return resolved;
      return input.client.createMessage(
        input.channelId,
        renderDigest(resolved.digest),
        nonce,
      );
    },
  };
}

async function withGuild(
  client: DiscordClient,
  channelId: string,
  digest: DigestInput,
): Promise<
  { ok: true; digest: DigestInput } | { ok: false; failure: SendFailure }
> {
  if (digest.guildId !== null || !needsGuild(digest)) {
    return { ok: true, digest };
  }
  const looked = await client.getChannelGuild(channelId);
  if (!looked.ok) return looked;
  return { ok: true, digest: { ...digest, guildId: looked.guildId } };
}

function needsGuild(digest: DigestInput): boolean {
  return digest.lowest.some(
    (review) =>
      review.channelId !== null &&
      review.messageId !== null &&
      (review.title?.trim() ?? "") !== "",
  );
}

function pointer(ref: MessageRef, channelId: string): string {
  if (ref.guildId === undefined) return supersededLine(null);
  const link = `https://discord.com/channels/${ref.guildId}/${channelId}/${ref.messageId}`;
  return supersededLine(link);
}

// null means the new message stands. A returned failure is retried with the same nonce.
async function pointAtNewer(
  client: DiscordClient,
  previous: MessageRef,
  line: string,
): Promise<Extract<
  Awaited<ReturnType<DiscordClient["editMessage"]>>,
  { ok: false }
> | null> {
  const read = await client.getMessage(previous);
  if (!read.ok) {
    if (read.failure.kind === "gone" || read.failure.kind === "invalid") {
      log("supersede_skipped", failureFields(read.failure));
      return null;
    }
    return { ok: false, failure: read.failure };
  }
  const stripped = supersedeComponents(read.components, line);
  if (!stripped.ok) {
    log("supersede_skipped", { kind: "shape" });
    return null;
  }
  const edited = await client.editMessage(previous, {
    flags: COMPONENTS_V2,
    components: stripped.components,
  });
  if (edited.ok) return null;
  if (edited.failure.kind === "gone" || edited.failure.kind === "invalid") {
    log("supersede_skipped", failureFields(edited.failure));
    return null;
  }
  return edited;
}

function failureFields(failure: { kind: string; status?: number }): {
  kind: string;
  status?: number;
} {
  if (failure.status === undefined) return { kind: failure.kind };
  return { kind: failure.kind, status: failure.status };
}
