import { afterEach, expect, it, vi } from "vitest";
import {
  createChartClient, createImagePublisher, createKisTokenCache, createSymbolStore,
} from "../supabase/functions/stock-chart-bot/adapters.ts";

function stub(handler: (url: URL, init: RequestInit) => Response) {
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(new URL(String(input)), init));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const client = () => createChartClient("https://supabase.test", "fixture-service-key");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reads the seed document and atomic alias snapshot through the storage contract", async () => {
  const fetch = stub((url) => Response.json(url.pathname.includes("/rpc/")
    ? [{ key: "삼전", value: "005930.KS" }]
    : { entries: [{ key: "삼성전자", value: "005930.KS" }, { key: "삼전", value: "005930.KS", alias: true }] }));
  const store = createSymbolStore(client());
  expect(await store.readSeed()).toEqual([{ key: "삼성전자", value: "005930.KS" }, { key: "삼전", value: "005930.KS", alias: true }]);
  expect(await store.readAliases()).toEqual([{ key: "삼전", value: "005930.KS" }]);
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("id")).toBe("eq.symbols:v1");
  expect(new URL(String(fetch.mock.calls[1][0])).pathname).toBe("/rest/v1/rpc/read_chart_aliases");
});

it("passes alias changes and millisecond request identities to one RPC", async () => {
  const fetch = stub(() => Response.json({ entry: { key: "삼전", value: "005930.KS" } }));
  const store = createSymbolStore(client());
  const request = { key: "discord:fixture", expiresAt: 2_000_000_000_000 };
  expect(await store.mutateAlias({ key: "삼전", value: "005930.KS", request })).toEqual({ key: "삼전", value: "005930.KS" });
  expect(JSON.parse(fetch.mock.calls[0][1]?.body as string)).toEqual({
    p_key: "삼전", p_value: "005930.KS", p_request_key: request.key, p_expires_at_ms: request.expiresAt,
  });
  await store.mutateAlias({ key: "삼전" });
  expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({ p_key: "삼전" });
});

it("preserves mutation error meanings and does not expose backend error details", async () => {
  const fetch = stub(() => Response.json({ error: { status: 409, message: "sensitive-token" } }));
  const store = createSymbolStore(client());
  await expect(store.mutateAlias({ key: "삼전" })).rejects.toThrow("이미 처리한 별칭 변경 요청입니다.");
  fetch.mockImplementation(async () => Response.json({ code: "42501", message: "sensitive-token", details: "private data" }, { status: 403 }));
  await expect(store.mutateAlias({ key: "삼전" })).rejects.toThrow("별칭 변경에 실패했습니다.");
  await expect(store.readSeed()).rejects.toThrow("종목 목록을 불러오지 못했습니다.");
});

it("rejects malformed stored documents instead of caching invalid symbol data", async () => {
  stub(() => Response.json({ entries: [{ key: "삼성전자", value: 123 }] }));
  await expect(createSymbolStore(client()).readSeed()).rejects.toThrow("종목 목록 형식이 올바르지 않습니다.");
});

it("preserves token expiry units and stores the cache TTL separately", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  const fetch = stub((_url, init) => init.method === "POST"
    ? new Response(null, { status: 201 }) : Response.json({ token: "fixture-token", token_expires_at_sec: 1_800_086_400 }));
  const cache = createKisTokenCache(client());
  expect(await cache.get()).toEqual({ token: "fixture-token", expiresAt: 1_800_086_400 });
  expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("expires_at_ms")).toBe("gt.1800000000000");
  await cache.put({ token: "fixture-token", expiresAt: 1_800_086_400 }, 82_800);
  expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({
    key: "kis:token:v1", token: "fixture-token", token_expires_at_sec: 1_800_086_400, expires_at_ms: 1_800_082_800_000,
  });
  fetch.mockImplementation(async () => Response.json({ message: "sensitive-token" }, { status: 403 }));
  await expect(cache.get()).rejects.toThrow("시세 토큰 캐시를 불러오지 못했습니다.");
  await expect(cache.put({ token: "fixture-token", expiresAt: 1 }, 60)).rejects.toThrow("시세 토큰 캐시를 저장하지 못했습니다.");
});

it("publishes PNG with explicit metadata and returns a credential-free public URL", async () => {
  const fetch = stub(() => Response.json({ Key: "charts/fixture.png", Id: "fixture" }));
  const png = new Uint8Array([137, 80, 78, 71]);
  const url = await createImagePublisher(client()).publish(png, "https://bot.test/slack");
  expect(url).toMatch(/^https:\/\/supabase\.test\/storage\/v1\/object\/public\/charts\/[a-z0-9]+-[0-9a-f-]+\.png$/);
  expect(url).not.toContain("fixture-service-key");
  const headers = new Headers(fetch.mock.calls[0][1]?.headers);
  expect(headers.get("content-type")).toBe("image/png");
  expect(headers.get("cache-control")).toBe("max-age=86400");
  expect(headers.get("x-upsert")).toBe("false");
  expect(fetch.mock.calls[0][1]?.body).toEqual(png);
});
