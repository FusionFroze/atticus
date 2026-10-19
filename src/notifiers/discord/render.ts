import type {
  APIComponentInContainer,
  APIContainerComponent,
  APITextDisplayComponent,
  ComponentType,
} from "discord-api-types/v10";
import type { DigestInput, NoticeInput, ReviewMessageInput } from "../types";
import type { DiscordMessageBody } from "./client";
import {
  DIGEST_LABEL,
  DIGEST_QUIET,
  digestTitle,
  GOOGLE_AUTH_RECOVERED,
  GOOGLE_AUTH_WARNING,
  playForbiddenRecovered,
  playForbiddenWarning,
} from "./copy";
import {
  COMPONENTS_V2,
  charLength,
  hasText,
  TEXT_LIMIT,
  truncate,
} from "./parts";
import { type ReplyNote, renderComponentsReview } from "./render-v2";

export { truncate } from "./parts";

const TEXT_DISPLAY = 10 as ComponentType.TextDisplay;
const CONTAINER = 17 as ComponentType.Container;

export type { ReplyNote };

export function renderRepliedMessage(input: {
  review: ReviewMessageInput["review"];
  appName: string;
  consoleUrl: string | null;
  note: ReplyNote;
}): DiscordMessageBody {
  return renderComponentsReview(
    {
      review: input.review,
      appName: input.appName,
      consoleUrl: input.consoleUrl,
      mention: null,
      showUpdated: input.review.previousRating !== null,
    },
    null,
    input.note,
  );
}

export function renderReview(input: ReviewMessageInput): DiscordMessageBody {
  const mention = input.review.rating <= 2 ? input.mention : null;
  return renderComponentsReview(input, mention);
}

export function renderNotice(input: NoticeInput): DiscordMessageBody {
  return renderPlain(noticeText(input));
}

export function renderDigest(input: DigestInput): DiscordMessageBody {
  return renderPlain(digestBody(input), digestTitle(input.appName));
}

function digestBody(input: DigestInput): string {
  const lines = [DIGEST_LABEL];
  if (input.quiet) {
    lines.push("", DIGEST_QUIET);
    return lines.join("\n");
  }
  lines.push("", `**${input.newCount}** new · **${input.editedCount}** edited`);
  const average = averageLine(input);
  if (average !== null) lines.push(average);
  if (input.newCount > 0) {
    lines.push(
      "",
      ...distributionLines(input.distribution),
      "",
      replyLine(input),
    );
  }
  if (input.versions.length > 0) {
    lines.push("", "**By version**");
    for (const version of input.versions) {
      lines.push(`${version.name} · ${version.count}`);
    }
  }
  if (input.lowest.length > 0) {
    lines.push("", "**Lowest unanswered**");
    for (const review of input.lowest) {
      lines.push(lowestLine(review, input.guildId));
    }
  }
  return lines.join("\n");
}

function averageLine(input: DigestInput): string | null {
  if (input.averageRating === null) return null;
  const average = `Average **${tenth(input.averageRating)}**`;
  if (input.averageChange === null) return average;
  return `${average} · ${signedTenth(input.averageChange)} vs last week`;
}

function distributionLines(counts: DigestInput["distribution"]): string[] {
  return counts
    .map((count, index) => `${starBar(index + 1)}  ${count}`)
    .reverse();
}

function replyLine(input: DigestInput): string {
  const percent = Math.round((input.replyRate ?? 0) * 100);
  const base = `Replied **${input.repliedCount}/${input.newCount}** · ${percent}%`;
  if (input.medianReplySeconds === null) return base;
  return `${base} · median **${formatDuration(input.medianReplySeconds)}**`;
}

function lowestLine(
  review: DigestInput["lowest"][number],
  guildId: string | null,
): string {
  const stars = `★${review.rating}`;
  const title = linkLabel(review.title);
  const url = messageUrl(guildId, review.channelId, review.messageId);
  if (title === null || url === null) return stars;
  return `${stars} · [${title}](${url})`;
}

function linkLabel(title: string | null): string | null {
  const cleaned = (title ?? "")
    .replaceAll(/[[\]]/g, "")
    .replaceAll("\n", " ")
    .trim();
  return cleaned === "" ? null : cleaned;
}

function messageUrl(
  guildId: string | null,
  channelId: string | null,
  messageId: string | null,
): string | null {
  if (guildId === null || channelId === null || messageId === null) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function starBar(rating: number): string {
  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}

function tenth(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function signedTenth(value: number): string {
  const tenths = Math.round(value * 10);
  const text = (Math.abs(tenths) / 10).toFixed(1);
  if (tenths < 0) return `\u2212${text}`;
  return `+${text}`;
}

function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  if (whole < 60) return `${whole}s`;
  const minutes = Math.round(whole / 60);
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return `${mins}m`;
    if (mins === 0) return `${hours}h`;
    return `${hours}h ${mins}m`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (hours === 0) return `${days}d`;
  return `${days}d ${hours}h`;
}

function renderPlain(text: string, title?: string): DiscordMessageBody {
  const children: APIComponentInContainer[] = [];
  let used = 0;
  if (title !== undefined && hasText(title)) {
    const heading = truncate(title, TEXT_LIMIT);
    children.push(textDisplay(heading));
    used += charLength(heading);
  }
  const body = truncate(text, Math.max(1, TEXT_LIMIT - used));
  if (body !== "") children.push(textDisplay(body));
  const container: APIContainerComponent = {
    type: CONTAINER,
    components: children,
  };
  return { flags: COMPONENTS_V2, components: [container] };
}

function noticeText(input: NoticeInput): string {
  if (input.kind === "connected") return connectedText(input);
  if (input.kind === "warning") {
    return input.warning === "google_auth"
      ? GOOGLE_AUTH_WARNING
      : playForbiddenWarning(input.appName);
  }
  return input.subject === "google_auth"
    ? GOOGLE_AUTH_RECOVERED
    : playForbiddenRecovered(input.appName);
}

function connectedText(
  input: Extract<NoticeInput, { kind: "connected" }>,
): string {
  const app = input.appName;
  if (input.count === 0) {
    return `Connected to **${app}** ✓ No written reviews in the last 7 days. New ones will appear here.`;
  }
  if (input.backfill === "silent") {
    return `Connected to **${app}** ✓ Found ${input.count} written reviews from the last 7 days. They're saved; only new reviews will be posted.`;
  }
  return `Connected to **${app}** ✓ Found ${input.count} written reviews from the last 7 days. Posting them below, oldest first.`;
}

function textDisplay(content: string): APITextDisplayComponent {
  return { type: TEXT_DISPLAY, content };
}
