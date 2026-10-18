import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Read in Node. The setup file applies these inside the Workers runtime.
      const migrations = await readD1Migrations(
        path.join(import.meta.dirname, "migrations"),
      );
      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Wrangler still reads .dev.vars next to the config. These replace its secrets,
        // so the real service-account key never reaches a test.
        miniflare: {
          bindings: {
            GOOGLE_SERVICE_ACCOUNT_JSON: "test-placeholder",
            DISCORD_BOT_TOKEN: "test-placeholder",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
