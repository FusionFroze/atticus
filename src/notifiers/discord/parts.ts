import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIComponentInMessageActionRow,
  ButtonStyle,
  ComponentType,
} from "discord-api-types/v10";
import { replyWouldNotify } from "../../core/reply";
import type { StoredReview } from "../../core/review";
import type { ReviewMessageInput } from "../types";
import type { DiscordMessageBody } from "./client";

export const COLOR_LOW = 0xed4245;
export const COLOR_MID = 0xfee75c;
export const COLOR_HIGH = 0x57f287;
export const TITLE_LIMIT = 256;
export const FOOTER_LIMIT = 2048;
// The official component page does not print this cap. discord.js and the API notes use 4000.
export const TEXT_LIMIT = 4000;
export const COMPONENTS_V2 = 1 << 15;

const URL_LIMIT = 512;
const ACTION_ROW = 1 as ComponentType.ActionRow;
const BUTTON = 2 as ComponentType.Button;
const PRIMARY = 1 as ButtonStyle.Primary;
const SECONDARY = 2 as ButtonStyle.Secondary;
const LINK = 5 as ButtonStyle.Link;

export type Mention = ReviewMessageInput["mention"];

export function truncate(text: string, limit: number): string {
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  if (limit < 1) return "";
  return `${chars.slice(0, limit - 1).join("")}…`;
}

export function charLength(text: string): number {
  return Array.from(text).length;
}

export function hasText(text: string): boolean {
  return text.trim() !== "";
}

export function clip(text: string, limit: number): string | undefined {
  if (limit < 1 || !hasText(text)) return undefined;
  const shown = truncate(text, limit);
  return shown === "" ? undefined : shown;
}

export function reviewHeading(review: StoredReview): string {
  const head = `${stars(review.rating)} ${review.rating}/5`;
  const title = review.title?.trim() ?? "";
  return truncate(title === "" ? head : `${head} · ${title}`, TITLE_LIMIT);
}

export function footerText(review: StoredReview, appName: string): string {
  const author = review.author?.trim() ?? "";
  const name = author === "" ? "Anonymous" : author;
  return truncate(
    `${name} · ${appName} · <t:${review.modifiedAt}:R>`,
    FOOTER_LIMIT,
  );
}

export function ratingColor(rating: StoredReview["rating"]): number {
  if (rating <= 2) return COLOR_LOW;
  if (rating === 3) return COLOR_MID;
  return COLOR_HIGH;
}

export function originalLabel(review: StoredReview): string | null {
  if (review.originalBody === null) return null;
  const language = review.language?.trim() ?? "";
  return language === "" ? "Translated" : `Translated from ${language}`;
}

export function metaPairs(review: StoredReview): Array<[string, string]> {
  const pairs: Array<[string, string | null]> = [
    ["App version", review.appVersionName],
    ["Android", review.osVersion],
    ["Device", review.device],
    ["Language", review.language],
  ];
  const present: Array<[string, string]> = [];
  for (const [name, value] of pairs) {
    const text = value?.trim() ?? "";
    if (text !== "") present.push([name, text]);
  }
  return present;
}

export function metaLine(review: StoredReview): string | null {
  const line = metaPairs(review)
    .map(([name, value]) => `${name}: ${value}`)
    .join(" · ");
  return line === "" ? null : line;
}

export function actionRow(
  review: StoredReview,
  consoleUrl: string | null,
): APIActionRowComponent<APIComponentInMessageActionRow> {
  const customId = `reply:${review.id}`;
  const reply: APIButtonComponent = replyWouldNotify(review)
    ? { type: BUTTON, style: PRIMARY, label: "Reply", custom_id: customId }
    : {
        type: BUTTON,
        style: SECONDARY,
        label: "Edit reply",
        custom_id: customId,
      };
  const buttons: APIButtonComponent[] = [reply];
  if (
    consoleUrl !== null &&
    consoleUrl !== "" &&
    consoleUrl.length <= URL_LIMIT
  ) {
    buttons.push({
      type: BUTTON,
      style: LINK,
      label: "Open in Play Console",
      url: consoleUrl,
    });
  }
  return { type: ACTION_ROW, components: buttons };
}

export function mentionFields(
  mention: Mention,
  inContent: boolean,
): Pick<DiscordMessageBody, "content" | "allowedMentions"> {
  if (mention === null) return {};
  const allowedMentions =
    mention.kind === "role" ? { roles: [mention.id] } : { users: [mention.id] };
  const token =
    mention.kind === "role" ? `<@&${mention.id}>` : `<@${mention.id}>`;
  if (!inContent) return { allowedMentions };
  return { content: token, allowedMentions };
}

function stars(rating: StoredReview["rating"]): string {
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}
