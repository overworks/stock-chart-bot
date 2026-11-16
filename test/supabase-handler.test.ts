import { afterEach, expect, it, vi } from "vitest";
import { createSupabaseHandler, normalizeRequest } from "../supabase/functions/stock-chart-bot/handler.ts";
import { serverKey } from "../supabase/functions/stock-chart-bot/config.ts";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(["/functions/v1/stock-chart-bot", "/stock-chart-bot", ""])("preserves raw signed bodies while routing %s", async (prefix) => {
  const values: Record<string, string> = {
    SUPABASE_URL: "https://supabase.test", SUPABASE_SECRET_KEYS: '{"default":"fixture-key"}',
    SLACK_SIGNING_SECRET: "fixture-secret",
  };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const render = vi.fn(async () => new Uint8Array());
  const tasks = { waitUntil: vi.fn() };
  const handler = createSupabaseHandler((name) => values[name], render, tasks);
  const body = new URLSearchParams({ command: "/stock-help", text: "한글 원문 + 공백" }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(values.SLACK_SIGNING_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const response = await handler(new Request(`https://bot.test${prefix}/slack`, { method: "POST", body, headers: {
    "X-Slack-Request-Timestamp": timestamp,
    "X-Slack-Signature": `v0=${[...signature].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
  } }));
  expect((await response.json() as { response_type: string }).response_type).toBe("ephemeral");
  expect(render).not.toHaveBeenCalled();
  expect(tasks.waitUntil).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("does not strip another function's prefix or mutate unrelated requests", () => {
  const request = new Request("https://bot.test/functions/v1/stock-chart-bot-other/slack");
  expect(normalizeRequest(request)).toBe(request);
  expect(normalizeRequest(new Request("https://bot.test/functions/v1/stock-chart-bot")).url).toBe("https://bot.test/");
});

it("prefers the default secret key and supports the legacy service-role environment", () => {
  const values: Record<string, string> = { SUPABASE_SECRET_KEYS: '{"default":"modern"}', SUPABASE_SERVICE_ROLE_KEY: "legacy" };
  expect(serverKey((name) => values[name])).toBe("modern");
  delete values.SUPABASE_SECRET_KEYS;
  expect(serverKey((name) => values[name])).toBe("legacy");
});

it("rejects malformed or missing server settings without exposing secret values", () => {
  expect(() => serverKey(() => '{"default":"sensitive')).toThrow("Supabase 서버 키 설정 형식이 올바르지 않습니다.");
  expect(() => serverKey(() => undefined)).toThrow("Supabase 서버 키가 필요합니다.");
  expect(() => createSupabaseHandler(() => undefined, vi.fn(), { waitUntil: vi.fn() })).toThrow("Supabase API 주소가 필요합니다.");
});
