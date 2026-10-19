import type { AppConfig, Config } from "../../config/types";
import type { StoredReview } from "../../core/review";
import { isRecord } from "../../lib/record";

export function actingUserId(payload: Record<string, unknown>): string | null {
  if (isRecord(payload.member) && isRecord(payload.member.user)) {
    const id = payload.member.user.id;
    if (typeof id === "string" && id !== "") return id;
  }
  if (isRecord(payload.user) && typeof payload.user.id === "string") {
    return payload.user.id === "" ? null : payload.user.id;
  }
  return null;
}

export function readCustomId(payload: Record<string, unknown>): string | null {
  if (!isRecord(payload.data)) return null;
  return typeof payload.data.custom_id === "string"
    ? payload.data.custom_id
    : null;
}

export function customIdPrefix(
  customId: string | null,
): "reply" | "reply-modal" | "unknown" {
  if (customId === null) return "unknown";
  if (customId.startsWith("reply-modal:")) return "reply-modal";
  if (customId.startsWith("reply:")) return "reply";
  return "unknown";
}

export function reviewPk(
  customId: string | null,
  prefix: "reply" | "reply-modal",
): number | null {
  if (customId === null) return null;
  const head = prefix === "reply" ? "reply:" : "reply-modal:";
  const rest = customId.slice(head.length);
  if (!/^[1-9][0-9]*$/.test(rest)) return null;
  const id = Number(rest);
  if (!Number.isSafeInteger(id)) return null;
  return id;
}

export function readToken(payload: Record<string, unknown>): string | null {
  return typeof payload.token === "string" && payload.token !== ""
    ? payload.token
    : null;
}

export function readReplyText(payload: Record<string, unknown>): string | null {
  if (!isRecord(payload.data) || !Array.isArray(payload.data.components)) {
    return null;
  }
  for (const component of payload.data.components) {
    const value = textValue(component);
    if (value !== null) return value;
  }
  return null;
}

export function findApp(
  config: Config,
  review: StoredReview,
): AppConfig | null {
  return (
    config.apps.find(
      (app) => app.store === review.store && app.id === review.appId,
    ) ?? null
  );
}

function textValue(component: unknown): string | null {
  if (!isRecord(component)) return null;
  if (
    component.custom_id === "reply-text" &&
    typeof component.value === "string"
  ) {
    return component.value;
  }
  const nested = textValue(component.component);
  if (nested !== null) return nested;
  if (!Array.isArray(component.components)) return null;
  for (const child of component.components) {
    const value = textValue(child);
    if (value !== null) return value;
  }
  return null;
}
