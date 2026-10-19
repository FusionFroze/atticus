import type {
  APIComponentInContainer,
  APIContainerComponent,
  APISeparatorComponent,
  APITextDisplayComponent,
  ComponentType,
} from "discord-api-types/v10";
import type { StoredReview } from "../../core/review";
import type { ReviewMessageInput } from "../types";
import type { DiscordMessageBody } from "./client";
import {
  DRY_RUN_MARKER,
  publishedReply,
  REVIEW_UPDATED,
  ratingChange,
  repliedBy,
  repliedInConsole,
} from "./copy";
import {
  actionRow,
  COMPONENTS_V2,
  charLength,
  clip,
  footerText,
  hasText,
  type Mention,
  mentionFields,
  metaLine,
  originalLabel,
  ratingColor,
  reviewHeading,
  TEXT_LIMIT,
  truncate,
} from "./parts";

const TEXT_DISPLAY = 10 as ComponentType.TextDisplay;
const SEPARATOR = 14 as ComponentType.Separator;
const CONTAINER = 17 as ComponentType.Container;

export type ReplyNote =
  | { kind: "published"; text: string; userId: string; at: number }
  | { kind: "dry_run"; text: string };

// `note` is set only by the interaction edit. The cron render reads the stored reply.
export function renderComponentsReview(
  input: ReviewMessageInput,
  mention: Mention,
  note: ReplyNote | null = null,
): DiscordMessageBody {
  const title = reviewHeading(input.review);
  const footer = footerText(input.review, input.appName);
  const mentionText = mentionToken(mention);
  const metaRaw = metaLine(input.review) ?? "";
  const label = originalLabel(input.review);
  const originalRaw = input.review.originalBody ?? "";
  const banner = bannerLines(input);
  const reply = replyLines(input.review, note);
  const cap = Math.max(0, TEXT_LIMIT - textTotal([...banner, ...reply]));
  let bodyLimit = hasText(input.review.body) ? cap : 0;
  let originalLimit = label !== null && hasText(originalRaw) ? cap : 0;
  let metaLimit = metaRaw === "" ? 0 : cap;

  for (let guard = 0; guard < 12; guard += 1) {
    const laid = layout(
      input.review.body,
      bodyLimit,
      label,
      originalRaw,
      originalLimit,
      metaRaw,
      metaLimit,
    );
    const total = textTotal([
      mentionText,
      title,
      laid.body,
      laid.original,
      laid.meta,
      footer,
    ]);
    if (total <= cap) {
      return finish(
        input,
        mention,
        [mentionText, title, laid.body, laid.original, laid.meta, footer],
        banner,
        reply,
      );
    }
    const over = total - cap;
    if (laid.body !== undefined && charLength(laid.body) > 1) {
      bodyLimit = Math.max(0, charLength(laid.body) - over);
      continue;
    }
    bodyLimit = 0;
    if (laid.original !== undefined && charLength(laid.original) > 1) {
      originalLimit = Math.max(0, charLength(laid.original) - over);
      continue;
    }
    if (laid.meta !== undefined && charLength(laid.meta) > 1) {
      metaLimit = Math.max(0, charLength(laid.meta) - over);
      continue;
    }
    break;
  }

  return finish(
    input,
    mention,
    [mentionText, title, undefined, undefined, undefined, footer],
    banner,
    reply,
  );
}

function finish(
  input: ReviewMessageInput,
  mention: Mention,
  parts: readonly (string | undefined)[],
  banner: readonly string[],
  reply: readonly string[],
): DiscordMessageBody {
  const [ping, title, body, original, meta, footer] = parts;
  const children: APIComponentInContainer[] = [];
  if (ping !== undefined) children.push(textDisplay(ping));
  for (const line of banner) children.push(textDisplay(line));
  if (title !== undefined) children.push(textDisplay(title));
  if (body !== undefined) children.push(textDisplay(body));
  if (original !== undefined) children.push(textDisplay(original));
  children.push(separator());
  if (meta !== undefined) children.push(textDisplay(meta));
  if (footer !== undefined) children.push(textDisplay(footer));
  if (reply.length > 0) {
    children.push(separator());
    for (const line of reply) children.push(textDisplay(line));
  }
  children.push(actionRow(input.review, input.consoleUrl));
  const container: APIContainerComponent = {
    type: CONTAINER,
    accent_color: ratingColor(input.review.rating),
    components: children,
  };
  return {
    flags: COMPONENTS_V2,
    components: [container],
    ...mentionFields(mention, false),
  };
}

function layout(
  bodyRaw: string,
  bodyLimit: number,
  label: string | null,
  originalRaw: string,
  originalLimit: number,
  metaRaw: string,
  metaLimit: number,
): {
  body: string | undefined;
  original: string | undefined;
  meta: string | undefined;
} {
  return {
    body: clip(bodyRaw, bodyLimit),
    original: originalText(label, originalRaw, originalLimit),
    meta: clip(metaRaw, metaLimit),
  };
}

function originalText(
  label: string | null,
  raw: string,
  limit: number,
): string | undefined {
  if (label === null || limit < 1 || !hasText(raw)) return undefined;
  const prefix = `**${label}**\n`;
  if (charLength(prefix) >= limit) return truncate(prefix, limit);
  return `${prefix}${truncate(raw, limit - charLength(prefix))}`;
}

function bannerLines(input: ReviewMessageInput): readonly string[] {
  if (!input.showUpdated) return [];
  const previous = input.review.previousRating;
  if (previous === null || previous === input.review.rating) {
    return [REVIEW_UPDATED];
  }
  return [REVIEW_UPDATED, ratingChange(previous, input.review.rating)];
}

function replyLines(
  review: StoredReview,
  note: ReplyNote | null,
): readonly string[] {
  if (note !== null) {
    if (note.kind === "dry_run") {
      return [publishedReply(note.text), DRY_RUN_MARKER];
    }
    return [publishedReply(note.text), repliedBy(note.userId, note.at)];
  }
  if (review.replyText === null) return [];
  const text = publishedReply(review.replyText);
  if (review.repliedVia === "external" && review.replyModifiedAt !== null) {
    return [text, repliedInConsole(review.replyModifiedAt)];
  }
  if (review.repliedVia === "bot" && review.repliedBy !== null) {
    const at = review.repliedAt ?? review.replyModifiedAt;
    if (at !== null) return [text, repliedBy(review.repliedBy, at)];
  }
  return [text];
}

function textDisplay(content: string): APITextDisplayComponent {
  return { type: TEXT_DISPLAY, content: truncate(content, TEXT_LIMIT) };
}

function separator(): APISeparatorComponent {
  return { type: SEPARATOR };
}

function mentionToken(mention: Mention): string | undefined {
  if (mention === null) return undefined;
  return mention.kind === "role" ? `<@&${mention.id}>` : `<@${mention.id}>`;
}

function textTotal(parts: readonly (string | undefined)[]): number {
  let total = 0;
  for (const part of parts) {
    if (part !== undefined) total += charLength(part);
  }
  return total;
}
