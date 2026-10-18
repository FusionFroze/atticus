// Bindings the Worker receives. Secrets arrive as strings; JSON vars may arrive already parsed.
export type Env = {
  APPS: string | readonly unknown[];
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;
  ALLOWED_USER_IDS: string;
  TRANSLATION_LANGUAGE?: string;
  BACKFILL?: string;
  PING_ON_LOW_RATING?: string;
  TIMEZONE?: string;
  DIGEST_ENABLED?: string | boolean;
  DIGEST_DAY?: string;
  DIGEST_HOUR?: string | number;
  DRY_RUN?: string | boolean;
};
