import { isRecord } from "../lib/record";
import { parseApps } from "./apps";
import { parseGoogle } from "./google";
import {
  CONFIG_VAR,
  DISCORD_SECRET,
  DISCORD_VAR,
  isIanaTimezone,
  parseBoolean,
  requiredPublicKey,
  requiredSnowflake,
  requiredText,
  SNOWFLAKE,
} from "./text";
import type { Config, DigestDay, ParseResult } from "./types";

const LANGUAGE = /^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*$/;

// Sunday is 0, matching Date#getDay().
const DAYS: Record<string, DigestDay> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function parseConfig(env: unknown): ParseResult {
  if (!isRecord(env)) {
    return {
      ok: false,
      errors: ["Config is missing. The Worker env was not an object."],
    };
  }

  const errors: string[] = [];
  const apps = parseApps(env.APPS, errors);
  const google = parseGoogle(env.GOOGLE_SERVICE_ACCOUNT_JSON, errors);
  const discord = parseDiscord(env, errors);
  const allowedUserIds = parseAllowed(env.ALLOWED_USER_IDS, errors);
  const translationLanguage = parseTranslation(
    env.TRANSLATION_LANGUAGE,
    errors,
  );
  const backfill = parseBackfill(env.BACKFILL, errors);
  const pingOnLowRating = parsePing(env.PING_ON_LOW_RATING, errors);
  const timezone = parseTimezone(env.TIMEZONE, errors);
  const digest = parseDigest(env, errors);
  const dryRun = parseBoolean(
    env.DRY_RUN,
    "DRY_RUN",
    false,
    CONFIG_VAR,
    errors,
  );

  if (
    errors.length > 0 ||
    apps === null ||
    google === null ||
    discord === null ||
    allowedUserIds === null ||
    backfill === null ||
    timezone === null ||
    digest === null ||
    dryRun === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      apps,
      google,
      discord,
      allowedUserIds,
      translationLanguage,
      backfill,
      pingOnLowRating,
      timezone,
      digest,
      dryRun,
    },
  };
}

function parseDiscord(
  env: Record<string, unknown>,
  errors: string[],
): Config["discord"] | null {
  const botToken = requiredText(
    env.DISCORD_BOT_TOKEN,
    "DISCORD_BOT_TOKEN",
    DISCORD_SECRET,
    errors,
  );
  const applicationId = requiredSnowflake(
    env.DISCORD_APPLICATION_ID,
    "DISCORD_APPLICATION_ID",
    errors,
  );
  const publicKey = requiredPublicKey(env.DISCORD_PUBLIC_KEY, errors);
  const channelId = requiredSnowflake(
    env.DISCORD_CHANNEL_ID,
    "DISCORD_CHANNEL_ID",
    errors,
  );
  if (
    botToken === null ||
    applicationId === null ||
    publicKey === null ||
    channelId === null
  ) {
    return null;
  }
  return { botToken, applicationId, publicKey, channelId };
}

function parseAllowed(
  value: unknown,
  errors: string[],
): ReadonlySet<string> | null {
  if (value === undefined) {
    errors.push(`\`ALLOWED_USER_IDS\` is missing. ${DISCORD_VAR}`);
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    errors.push(
      `\`ALLOWED_USER_IDS\` is empty. Set at least one Discord user id. ${DISCORD_VAR}`,
    );
    return null;
  }
  if (typeof value !== "string") {
    errors.push(
      `\`ALLOWED_USER_IDS\` must be a comma-separated list of Discord user ids. ${DISCORD_VAR}`,
    );
    return null;
  }

  const ids = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (ids.length === 0) {
    errors.push(
      `\`ALLOWED_USER_IDS\` is empty. Set at least one Discord user id. ${DISCORD_VAR}`,
    );
    return null;
  }

  const invalid = ids.some((id) => !SNOWFLAKE.test(id));
  if (invalid) {
    errors.push(
      `\`ALLOWED_USER_IDS\` must be a comma-separated list of Discord snowflakes (17-20 digits). ${DISCORD_VAR}`,
    );
    return null;
  }
  return new Set(ids);
}

function parseTranslation(value: unknown, errors: string[]): string | null {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string" || !LANGUAGE.test(value.trim())) {
    errors.push(
      `\`TRANSLATION_LANGUAGE\` must be a language code such as en or en_GB. ${CONFIG_VAR}`,
    );
    return null;
  }
  return value.trim();
}

function parseBackfill(
  value: unknown,
  errors: string[],
): Config["backfill"] | null {
  if (value === undefined || value === "") return "post";
  if (value === "post" || value === "silent") return value;
  errors.push(`\`BACKFILL\` must be post or silent. ${CONFIG_VAR}`);
  return null;
}

function parsePing(
  value: unknown,
  errors: string[],
): Config["pingOnLowRating"] {
  if (value === undefined || value === "") return null;
  if (typeof value !== "string") {
    errors.push(
      `\`PING_ON_LOW_RATING\` must be a user id, or a role id prefixed with &. ${DISCORD_VAR}`,
    );
    return null;
  }
  const trimmed = value.trim();
  const role = /^&([0-9]{17,20})$/.exec(trimmed);
  const roleId = role?.[1];
  if (roleId !== undefined) return { kind: "role", id: roleId };
  if (SNOWFLAKE.test(trimmed)) return { kind: "user", id: trimmed };
  errors.push(
    `\`PING_ON_LOW_RATING\` must be a user id, or a role id prefixed with &. ${DISCORD_VAR}`,
  );
  return null;
}

function parseTimezone(value: unknown, errors: string[]): string | null {
  if (value === undefined || value === "") return "UTC";
  if (typeof value !== "string" || !isIanaTimezone(value.trim())) {
    errors.push(`\`TIMEZONE\` is not a valid IANA timezone. ${CONFIG_VAR}`);
    return null;
  }
  return value.trim();
}

function parseDigest(
  env: Record<string, unknown>,
  errors: string[],
): Config["digest"] | null {
  const enabled = parseBoolean(
    env.DIGEST_ENABLED,
    "DIGEST_ENABLED",
    true,
    CONFIG_VAR,
    errors,
  );
  const day = parseDay(env.DIGEST_DAY, errors);
  const hour = parseHour(env.DIGEST_HOUR, errors);
  if (enabled === null || day === null || hour === null) return null;
  return { enabled, day, hour };
}

function parseDay(value: unknown, errors: string[]): DigestDay | null {
  if (value === undefined || value === "") return 1;
  const day = typeof value === "string" ? DAYS[value.trim()] : undefined;
  if (day === undefined) {
    errors.push(
      `\`DIGEST_DAY\` must be mon, tue, wed, thu, fri, sat or sun. ${CONFIG_VAR}`,
    );
    return null;
  }
  return day;
}

function parseHour(value: unknown, errors: string[]): number | null {
  if (value === undefined || value === "") return 9;
  // Digits only, so Number() can't accept "0x9" or "1e1".
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]{1,2}$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 23) {
    errors.push(
      `\`DIGEST_HOUR\` must be an integer from 0 to 23. ${CONFIG_VAR}`,
    );
    return null;
  }
  return numeric;
}
