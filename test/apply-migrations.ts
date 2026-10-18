import { applyD1Migrations, type D1Migration, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

// Setup can run more than once. Already-recorded migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
