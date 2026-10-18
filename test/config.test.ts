import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/parse";

const PEM = "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n";
const PUBLIC_KEY = "ab".repeat(32);

function validEnv(): Record<string, unknown> {
  return {
    APPS: [
      {
        store: "play",
        id: "com.fusionfroze.Lune",
        name: "Lune",
        consoleUrl:
          "https://play.google.com/console/u/0/developers/1/app/2/user-feedback/reviews",
      },
    ],
    GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      client_email: "atticus@example.iam.gserviceaccount.com",
      private_key: PEM,
    }),
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_PUBLIC_KEY: PUBLIC_KEY,
    DISCORD_CHANNEL_ID: "223456789012345678",
    ALLOWED_USER_IDS: "323456789012345678, 423456789012345678",
  };
}

describe("parseConfig", () => {
  it("applies defaults and accepts a JSON string for APPS", () => {
    const env = validEnv();
    env.APPS = JSON.stringify(env.APPS);
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.apps).toEqual([
      {
        store: "play",
        id: "com.fusionfroze.Lune",
        name: "Lune",
        consoleUrl:
          "https://play.google.com/console/u/0/developers/1/app/2/user-feedback/reviews",
      },
    ]);
    expect(parsed.config.google.clientEmail).toBe(
      "atticus@example.iam.gserviceaccount.com",
    );
    expect(parsed.config.allowedUserIds).toEqual(
      new Set(["323456789012345678", "423456789012345678"]),
    );
    expect(parsed.config.translationLanguage).toBeNull();
    expect(parsed.config.backfill).toBe("post");
    expect(parsed.config.pingOnLowRating).toBeNull();
    expect(parsed.config.timezone).toBe("UTC");
    expect(parsed.config.digest).toEqual({ enabled: true, day: 1, hour: 9 });
    expect(parsed.config.dryRun).toBe(false);
  });

  it("defaults a missing app name to the package id", () => {
    const env = validEnv();
    env.APPS = [{ store: "play", id: "com.fusionfroze.Lune" }];
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.apps[0]?.name).toBe("com.fusionfroze.Lune");
    expect(parsed.config.apps[0]?.consoleUrl).toBeNull();
  });

  it("names every missing required variable", () => {
    const parsed = parseConfig({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.errors.join("\n");
    for (const name of [
      "APPS",
      "GOOGLE_SERVICE_ACCOUNT_JSON",
      "DISCORD_BOT_TOKEN",
      "DISCORD_APPLICATION_ID",
      "DISCORD_PUBLIC_KEY",
      "DISCORD_CHANNEL_ID",
      "ALLOWED_USER_IDS",
    ]) {
      expect(text).toContain(`\`${name}\``);
      expect(text).toMatch(new RegExp(`\`${name}\` is (missing|empty)`));
    }
  });

  it("reports malformed values without copying any secret material", () => {
    const marker = "UNIQUE_SECRET_MARKER_z9Q";
    const env = validEnv();
    env.APPS = "{not json";
    env.GOOGLE_SERVICE_ACCOUNT_JSON = `{"private_key":"${marker}"}`;
    env.DISCORD_BOT_TOKEN = marker;
    env.DISCORD_APPLICATION_ID = "1234";
    env.DISCORD_PUBLIC_KEY = "abcd";
    env.DISCORD_CHANNEL_ID = "nope";
    env.ALLOWED_USER_IDS = "12";
    env.TRANSLATION_LANGUAGE = "??";
    env.BACKFILL = "summary";
    env.PING_ON_LOW_RATING = "@everyone";
    env.TIMEZONE = "Not/AZone";
    env.DIGEST_DAY = "monday";
    env.DIGEST_HOUR = 24;
    env.DIGEST_ENABLED = "yes";
    env.DRY_RUN = "yes";

    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.errors.join("\n");
    expect(text).not.toContain(marker);
    expect(text).toContain("`APPS` is not valid JSON.");
    expect(text).toContain(
      "`GOOGLE_SERVICE_ACCOUNT_JSON` is missing `client_email`.",
    );
    expect(text).toContain(
      "`GOOGLE_SERVICE_ACCOUNT_JSON` field `private_key` must be a PKCS#8 PEM private key.",
    );
    expect(text).toContain(
      "`DISCORD_APPLICATION_ID` must be a Discord snowflake (17-20 digits).",
    );
    expect(text).toContain("`DISCORD_PUBLIC_KEY` must be 64 hex characters.");
    expect(text).toContain(
      "`DISCORD_CHANNEL_ID` must be a Discord snowflake (17-20 digits).",
    );
    expect(text).toContain(
      "`ALLOWED_USER_IDS` must be a comma-separated list of Discord snowflakes",
    );
    expect(text).toContain("`TRANSLATION_LANGUAGE` must be a language code");
    expect(text).toContain("`BACKFILL` must be post or silent.");
    expect(text).toContain(
      "`PING_ON_LOW_RATING` must be a user id, or a role id prefixed with &.",
    );
    expect(text).toContain("`TIMEZONE` is not a valid IANA timezone.");
    expect(text).toContain(
      "`DIGEST_DAY` must be mon, tue, wed, thu, fri, sat or sun.",
    );
    expect(text).toContain("`DIGEST_HOUR` must be an integer from 0 to 23.");
    expect(text).toContain("`DIGEST_ENABLED` must be true or false.");
    expect(text).toContain("`DRY_RUN` must be true or false.");
  });

  it("rejects a bad app entry, an unknown field and a duplicate id", () => {
    const env = validEnv();
    env.APPS = [
      {
        store: "appstore",
        id: "com.fusionfroze.Lune",
        consoleURL: "https://play.google.com/console/x",
      },
      {
        store: "play",
        id: "com.fusionfroze.Lune",
        consoleUrl: "https://play.google.com/console/apps",
      },
      { store: "play", id: "com.fusionfroze.Lune" },
      {
        store: "play",
        id: "com.other",
        name: "",
        consoleUrl: "http://insecure.example",
      },
    ];
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.errors.join("\n");
    expect(text).toContain("`APPS[0].store` must be one of: play.");
    expect(text).toContain(
      "`APPS[0]` has unknown field `consoleURL`. Remove it.",
    );
    expect(text).toContain("`APPS[2].id` duplicates `com.fusionfroze.Lune`.");
    expect(text).toContain("`APPS[3].consoleUrl` must be an https URL.");
    expect(text).toContain("`APPS[3].name` must be a non-empty string.");
    for (const error of parsed.errors) {
      expect(error).toContain("Set it in wrangler.jsonc → vars");
    }
  });

  it("rejects a DIGEST_HOUR that only Number() would accept", () => {
    for (const hour of ["0x9", "1e1", "9.0", " "]) {
      const env = validEnv();
      env.DIGEST_HOUR = hour;
      const parsed = parseConfig(env);
      expect(parsed.ok, hour).toBe(false);
    }
  });

  it("rejects an empty allow-list and a service-account JSON object that is not an object", () => {
    const env = validEnv();
    env.ALLOWED_USER_IDS = " , ";
    env.GOOGLE_SERVICE_ACCOUNT_JSON = "[]";
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const text = parsed.errors.join("\n");
    expect(text).toContain("`ALLOWED_USER_IDS` is empty.");
    expect(text).toContain(
      "`GOOGLE_SERVICE_ACCOUNT_JSON` must be a JSON object.",
    );
    expect(text).not.toContain("[]");
  });

  it("accepts the optional values, including JSON booleans", () => {
    const env = validEnv();
    env.TRANSLATION_LANGUAGE = "en_GB";
    env.BACKFILL = "silent";
    env.PING_ON_LOW_RATING = "&523456789012345678";
    env.TIMEZONE = "Asia/Kolkata";
    env.DIGEST_ENABLED = false;
    env.DIGEST_DAY = "sun";
    env.DIGEST_HOUR = "0";
    env.DRY_RUN = "true";
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.translationLanguage).toBe("en_GB");
    expect(parsed.config.backfill).toBe("silent");
    expect(parsed.config.pingOnLowRating).toEqual({
      kind: "role",
      id: "523456789012345678",
    });
    expect(parsed.config.timezone).toBe("Asia/Kolkata");
    expect(parsed.config.digest).toEqual({ enabled: false, day: 0, hour: 0 });
    expect(parsed.config.dryRun).toBe(true);
  });

  it("accepts a user ping and a service-account object that is already parsed", () => {
    const env = validEnv();
    env.GOOGLE_SERVICE_ACCOUNT_JSON = {
      client_email: "atticus@example.iam.gserviceaccount.com",
      private_key: PEM,
      private_key_id: "ignored",
    };
    env.PING_ON_LOW_RATING = "623456789012345678";
    const parsed = parseConfig(env);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.config.pingOnLowRating).toEqual({
      kind: "user",
      id: "623456789012345678",
    });
  });
});
