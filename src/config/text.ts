export const DISCORD_VAR =
  "Set it in wrangler.jsonc → vars (README → Discord setup).";
export const CONFIG_VAR =
  "Set it in wrangler.jsonc → vars (README → Configuration).";
export const GOOGLE_SECRET =
  "Set it with wrangler secret put (README → Google setup).";
export const DISCORD_SECRET =
  "Set it with wrangler secret put (README → Discord setup).";

export const SNOWFLAKE = /^[0-9]{17,20}$/;
const PUBLIC_KEY = /^[0-9a-fA-F]{64}$/;

// `undefined` means the text was not JSON. JSON itself cannot encode undefined.
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname !== "";
  } catch {
    return false;
  }
}

export function isIanaTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function parseBoolean(
  value: unknown,
  name: string,
  fallback: boolean,
  where: string,
  errors: string[],
): boolean | null {
  if (value === undefined || value === "") return fallback;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  errors.push(`\`${name}\` must be true or false. ${where}`);
  return null;
}

export function requiredText(
  value: unknown,
  name: string,
  where: string,
  errors: string[],
): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`\`${name}\` is missing. ${where}`);
    return null;
  }
  return value.trim();
}

export function requiredSnowflake(
  value: unknown,
  name: string,
  errors: string[],
): string | null {
  if (value === undefined || value === "") {
    errors.push(`\`${name}\` is missing. ${DISCORD_VAR}`);
    return null;
  }
  if (typeof value !== "string" || !SNOWFLAKE.test(value.trim())) {
    errors.push(
      `\`${name}\` must be a Discord snowflake (17-20 digits). ${DISCORD_VAR}`,
    );
    return null;
  }
  return value.trim();
}

export function requiredPublicKey(
  value: unknown,
  errors: string[],
): string | null {
  if (value === undefined || value === "") {
    errors.push(`\`DISCORD_PUBLIC_KEY\` is missing. ${DISCORD_VAR}`);
    return null;
  }
  if (typeof value !== "string" || !PUBLIC_KEY.test(value.trim())) {
    errors.push(
      `\`DISCORD_PUBLIC_KEY\` must be 64 hex characters. ${DISCORD_VAR}`,
    );
    return null;
  }
  return value.trim();
}
