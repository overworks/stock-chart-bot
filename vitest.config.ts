import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import keypair from "./test/keypair.json" with { type: "json" };

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DISCORD_PUBLIC_KEY: keypair.publicHex,
          DISCORD_BOT_TOKEN: "test-bot-token",
          SLACK_SIGNING_SECRET: "test-signing-secret",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
