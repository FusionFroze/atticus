import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Wrangler still reads .dev.vars next to the config. These replace its secrets,
      // so the real service-account key never reaches a test.
      miniflare: {
        bindings: {
          GOOGLE_SERVICE_ACCOUNT_JSON: "test-placeholder",
          DISCORD_BOT_TOKEN: "test-placeholder",
        },
      },
    }),
  ],
});
