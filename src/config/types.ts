import type { Store } from "../core/review";

export type AppConfig = {
  store: Store;
  id: string;
  name: string;
  consoleUrl: string | null;
};

// 0 is Sunday, matching JavaScript's Date#getDay().
export type DigestDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Config = {
  apps: AppConfig[];
  google: { clientEmail: string; privateKeyPem: string };
  discord: {
    botToken: string;
    applicationId: string;
    publicKey: string;
    channelId: string;
  };
  allowedUserIds: ReadonlySet<string>;
  translationLanguage: string | null;
  backfill: "post" | "silent";
  pingOnLowRating: { kind: "role" | "user"; id: string } | null;
  timezone: string;
  digest: { enabled: boolean; day: DigestDay; hour: number };
  dryRun: boolean;
};

export type ParseResult =
  | { ok: true; config: Config }
  | { ok: false; errors: string[] };
