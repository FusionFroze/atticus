import type {
  APIComponentInContainer,
  APIContainerComponent,
  APISeparatorComponent,
  APITextDisplayComponent,
  ComponentType,
} from "discord-api-types/v10";
import type { ReviewMessageInput } from "../types";
import type { DiscordMessageBody } from "./client";
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

export function renderComponentsReview(
  input: ReviewMessageInput,
  mention: Mention,
): DiscordMessageBody {
  const title = reviewHeading(input.review);
  const footer = footerText(input.review, input.appName);
  const mentionText = mentionToken(mention);
  const metaRaw = metaLine(input.review) ?? "";
  const label = originalLabel(input.review);
  const originalRaw = input.review.originalBody ?? "";
  let bodyLimit = hasText(input.review.body) ? TEXT_LIMIT : 0;
  let originalLimit = label !== null && hasText(originalRaw) ? TEXT_LIMIT : 0;
  let metaLimit = metaRaw === "" ? 0 : TEXT_LIMIT;

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
    if (total <= TEXT_LIMIT) {
      return finish(input, mention, [
        mentionText,
        title,
        laid.body,
        laid.original,
        laid.meta,
        footer,
      ]);
    }
    const over = total - TEXT_LIMIT;
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

  return finish(input, mention, [
    mentionText,
    title,
    undefined,
    undefined,
    undefined,
    footer,
  ]);
}

function finish(
  input: ReviewMessageInput,
  mention: Mention,
  parts: readonly (string | undefined)[],
): DiscordMessageBody {
  const [ping, title, body, original, meta, footer] = parts;
  const children: APIComponentInContainer[] = [];
  if (ping !== undefined) children.push(textDisplay(ping));
  if (title !== undefined) children.push(textDisplay(title));
  if (body !== undefined) children.push(textDisplay(body));
  if (original !== undefined) children.push(textDisplay(original));
  children.push(separator());
  if (meta !== undefined) children.push(textDisplay(meta));
  if (footer !== undefined) children.push(textDisplay(footer));
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
