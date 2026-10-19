import type {
  APIComponentInContainer,
  APIContainerComponent,
  APITextDisplayComponent,
  ComponentType,
} from "discord-api-types/v10";
import type { DigestInput, NoticeInput, ReviewMessageInput } from "../types";
import type { DiscordMessageBody } from "./client";
import {
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
  return renderPlain(input.text, input.appName);
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
