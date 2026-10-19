import { truncate } from "./parts";

const TITLE_LIMIT = 45;

export const LABEL = "Your reply";
export const NEW_HINT =
  "Public on Google Play, under your developer name. Up to 350 characters.";
export const EDIT_HINT =
  "Public on Google Play, up to 350 characters. Editing doesn't notify the reviewer.";
export const NOT_ALLOWED =
  "Only people on this bot's allow-list can reply to reviews.";
export const WRONG_CHANNEL =
  "Replies only work in the channel Atticus posts to.";
export const NOT_SUPPORTED = "This action isn't supported.";
export const MISSING_REVIEW = "This review isn't in Atticus anymore.";
export const NOT_CONFIGURED =
  "Atticus isn't configured for this app. Nothing was published.";
export const EMPTY_REPLY = "A reply can't be empty. Nothing was published.";
export const TOO_LONG =
  "Replies can be at most 350 characters. Nothing was published.";
export const DRY_RUN_MARKER = "Dry run, not published.";
export const GOOGLE_REJECTED =
  "Google rejected the reply (too long or empty). Nothing was published.";
export const REVIEW_GONE = "This review no longer exists on Google Play.";
export const PERMISSION_MISSING =
  "The service account can't reply for this app. Check its permissions (README → Troubleshooting).";
export const GOOGLE_AUTH =
  "Atticus couldn't sign in to Google. Check the service account key (README → Troubleshooting).";
export const RATE_LIMITED =
  "Google is rate-limiting replies. Try again in a minute.";
export const PUBLISH_FAILED =
  "Something went wrong publishing the reply. Nothing was changed.";

export function modalTitle(author: string | null, rating: number): string {
  const trimmed = author?.trim() ?? "";
  const name = trimmed === "" ? "Anonymous" : trimmed;
  return truncate(`Reply to ${name} (${rating}★)`, TITLE_LIMIT);
}

export function publishedReply(text: string): string {
  return `**Your reply**\n${text}`;
}

export const REVIEW_UPDATED = "Review updated";
export const SUPERSEDED = "Updated, see the newer message.";

export function repliedBy(userId: string, at: number): string {
  return `Replied by <@${userId}> · <t:${at}:R>`;
}

export function ratingChange(previous: number, current: number): string {
  return `★${previous} → ★${current}`;
}

export function repliedInConsole(at: number): string {
  return `Replied in Play Console · <t:${at}:R>`;
}

export function supersededLine(link: string | null): string {
  if (link === null) return SUPERSEDED;
  return `Updated, see the [newer message](${link}).`;
}

export const GOOGLE_AUTH_WARNING =
  "⚠️ Atticus can't sign in to Google, so reviews aren't being checked. README → Troubleshooting → Google sign-in.";

export function playForbiddenWarning(appName: string): string {
  return `⚠️ Atticus doesn't have permission to read reviews for **${appName}**. New permissions can take up to a day to apply. README → Troubleshooting → Permission denied.`;
}

export const GOOGLE_AUTH_RECOVERED =
  "✓ Back to normal: Google sign-in is working again.";

export function playForbiddenRecovered(appName: string): string {
  return `✓ Back to normal: reading reviews for **${appName}** is working again.`;
}

export function replyFailureText(kind: string): string {
  switch (kind) {
    case "invalid":
      return GOOGLE_REJECTED;
    case "not_found":
      return REVIEW_GONE;
    case "forbidden":
      return PERMISSION_MISSING;
    case "auth":
      return GOOGLE_AUTH;
    case "rate_limited":
      return RATE_LIMITED;
    default:
      return PUBLISH_FAILED;
  }
}
