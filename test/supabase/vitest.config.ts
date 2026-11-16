import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`로컬 Supabase 검증 환경변수가 필요합니다: ${name}`);
  return value;
}

const url = required("SUPABASE_TEST_URL");
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error("통합 검증은 로컬 Supabase에서만 실행할 수 있습니다.");
}

export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [cloudflareTest({ miniflare: {
    compatibilityDate: "2026-09-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      SUPABASE_TEST_URL: url,
      SUPABASE_TEST_SERVICE_KEY: required("SUPABASE_TEST_SERVICE_KEY"),
      SUPABASE_TEST_ANON_KEY: required("SUPABASE_TEST_ANON_KEY"),
    },
  } })],
  test: {
    include: ["test/supabase/**/*.test.ts"], exclude: ["test/supabase/deno/**"],
    fileParallelism: false, testTimeout: 20_000, hookTimeout: 30_000,
  },
});
