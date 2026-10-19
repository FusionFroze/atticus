import type { AppConfig, Config } from "../../config/types";
import type { StoredReview } from "../../core/review";
import { publishReply, validateReplyText } from "../../jobs/reply";
import type { Budget } from "../../lib/budget";
import { log } from "../../lib/log";
import { isRecord } from "../../lib/record";
import type { ReviewSource } from "../../sources/types";
import { readReview } from "../../store";
import { createDiscordClient } from "./client";
import {
  EMPTY_REPLY,
  MISSING_REVIEW,
  NOT_ALLOWED,
  NOT_CONFIGURED,
  NOT_SUPPORTED,
  PUBLISH_FAILED,
  replyFailureText,
  TOO_LONG,
  WRONG_CHANNEL,
} from "./copy";
import { replyModal } from "./modal";
import {
  actingUserId,
  customIdPrefix,
  findApp,
  readCustomId,
  readReplyText,
  readToken,
  reviewPk,
} from "./payload";
import { renderRepliedMessage } from "./render";
import { verifyDiscordRequest } from "./verify";

const PING = 1;
const MESSAGE_COMPONENT = 3;
const MODAL_SUBMIT = 5;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED_UPDATE = 6;
const MODAL = 9;
const EPHEMERAL = 1 << 6;

export async function handleInteraction(input: {
  request: Request;
  config: Config;
  db: D1Database;
  source: ReviewSource;
  budget: Budget;
  waitUntil: (work: Promise<unknown>) => void;
  nowMs: number;
}): Promise<Response> {
  const body = await input.request.text();
  const verified = await verifyDiscordRequest({
    publicKey: input.config.discord.publicKey,
    timestamp: input.request.headers.get("x-signature-timestamp"),
    signature: input.request.headers.get("x-signature-ed25519"),
    body,
    nowMs: input.nowMs,
  });
  if (!verified.ok) {
    log("interaction_denied", { why: verified.reason });
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (!isRecord(payload) || typeof payload.type !== "number") {
    return new Response(null, { status: 400 });
  }
  if (payload.type === PING) {
    log("interaction", { type: PING });
    return Response.json({ type: PONG });
  }

  const userId = actingUserId(payload);
  if (userId === null || !input.config.allowedUserIds.has(userId)) {
    log("interaction_denied", { why: "allow_list" });
    return ephemeral(NOT_ALLOWED);
  }
  if (payload.channel_id !== input.config.discord.channelId) {
    log("interaction_denied", { why: "channel" });
    return ephemeral(WRONG_CHANNEL);
  }

  const customId = readCustomId(payload);
  const prefix = customIdPrefix(customId);
  if (payload.type === MESSAGE_COMPONENT && prefix === "reply") {
    return openModal(input, customId);
  }
  if (payload.type === MODAL_SUBMIT && prefix === "reply-modal") {
    return submitModal(input, payload, customId, userId);
  }
  log("interaction_denied", { why: "unknown" });
  return ephemeral(NOT_SUPPORTED);
}

async function openModal(
  input: InteractionInput,
  customId: string | null,
): Promise<Response> {
  const id = reviewPk(customId, "reply");
  if (id === null) {
    log("interaction_denied", { why: "unknown" });
    return ephemeral(NOT_SUPPORTED);
  }
  const review = await readReview(input.db, id);
  if (review === null) {
    log("interaction_denied", { why: "missing_review" });
    return ephemeral(MISSING_REVIEW);
  }
  if (findApp(input.config, review) === null) {
    log("interaction_denied", { why: "not_configured" });
    return ephemeral(NOT_CONFIGURED);
  }
  log("interaction", { type: MESSAGE_COMPONENT, customIdPrefix: "reply" });
  return Response.json({ type: MODAL, data: replyModal(review) });
}

async function submitModal(
  input: InteractionInput,
  payload: Record<string, unknown>,
  customId: string | null,
  userId: string,
): Promise<Response> {
  const id = reviewPk(customId, "reply-modal");
  if (id === null) {
    log("interaction_denied", { why: "unknown" });
    return ephemeral(NOT_SUPPORTED);
  }
  log("interaction", {
    type: MODAL_SUBMIT,
    customIdPrefix: "reply-modal",
  });
  const validated = validateReplyText(readReplyText(payload) ?? "");
  if (!validated.ok) {
    return ephemeral(validated.reason === "empty" ? EMPTY_REPLY : TOO_LONG);
  }
  const review = await readReview(input.db, id);
  if (review === null) {
    log("interaction_denied", { why: "missing_review" });
    return ephemeral(MISSING_REVIEW);
  }
  const app = findApp(input.config, review);
  if (app === null) {
    log("interaction_denied", { why: "not_configured" });
    return ephemeral(NOT_CONFIGURED);
  }
  const token = readToken(payload);
  if (token === null) return ephemeral(PUBLISH_FAILED);

  input.waitUntil(
    finishSubmit({
      ...input,
      app,
      review,
      userId,
      text: validated.text,
      token,
    }).catch(() => {
      log("reply_failed", {
        appId: review.appId,
        reviewId: review.reviewId,
        kind: "unavailable",
      });
    }),
  );
  return Response.json({ type: DEFERRED_UPDATE });
}

async function finishSubmit(input: SubmitInput): Promise<void> {
  const result = await publishReply({
    db: input.db,
    source: input.source,
    app: input.app,
    review: input.review,
    userId: input.userId,
    text: input.text,
    dryRun: input.config.dryRun,
    budget: input.budget,
    nowMs: input.nowMs,
  });
  const client = createDiscordClient({
    botToken: input.config.discord.botToken,
    budget: input.budget,
  });
  if (!result.ok) {
    const sent = await client.createFollowUp(
      input.config.discord.applicationId,
      input.token,
      replyFailureText(result.failure.kind),
    );
    if (!sent.ok) {
      log("reply_followup_failed", {
        reviewId: input.review.reviewId,
        kind: sent.failure.kind,
      });
    }
    return;
  }

  const edited = await client.editOriginal(
    input.config.discord.applicationId,
    input.token,
    renderRepliedMessage({
      review: result.review,
      appName: input.app.name,
      consoleUrl: input.app.consoleUrl,
      note:
        result.outcome === "dry_run"
          ? { kind: "dry_run", text: result.text }
          : {
              kind: "published",
              text: result.text,
              userId: input.userId,
              at: result.review.repliedAt ?? Math.floor(input.nowMs / 1000),
            },
    }),
  );
  if (!edited.ok) {
    log("reply_message_edit_failed", {
      reviewId: input.review.reviewId,
      kind: edited.failure.kind,
    });
  }
}

type InteractionInput = {
  config: Config;
  db: D1Database;
  source: ReviewSource;
  budget: Budget;
  waitUntil: (work: Promise<unknown>) => void;
  nowMs: number;
};

type SubmitInput = InteractionInput & {
  app: AppConfig;
  review: StoredReview;
  userId: string;
  text: string;
  token: string;
};

function ephemeral(content: string): Response {
  return Response.json({
    type: CHANNEL_MESSAGE,
    data: {
      content,
      flags: EPHEMERAL,
      allowed_mentions: { parse: [] },
    },
  });
}
