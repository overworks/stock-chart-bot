import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import keypair from "../test/keypair.json" with { type: "json" };

export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  plugins: [
    cloudflareTest({
      main: fileURLToPath(new URL("./index.ts", import.meta.url)),
      wrangler: { configPath: fileURLToPath(new URL("./wrangler.jsonc", import.meta.url)) },
      miniflare: {
        bindings: {
          DISCORD_APPLICATION_ID: "test-app-id",
          DISCORD_PUBLIC_KEY: keypair.publicHex,
          DISCORD_BOT_TOKEN: "test-bot-token",
          SLACK_SIGNING_SECRET: "test-signing-secret",
          SLACK_ALIAS_ADMINS: "U_ADMIN, U_OTHER",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/supabase/**"] },
});
