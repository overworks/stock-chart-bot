import { afterEach, expect, it, vi } from "vitest";
import { cloudflareMarketFetch } from "../cloudflare/http";
import { getPrices, searchRemote } from "../src/core/market";
import { createProviders } from "../src/providers";
import { createYahoo } from "../src/providers/yahoo";

const NOW = Date.parse("2026-09-12T12:00:00Z");
const chart = (close = [100, 101]) => ({ chart: { result: [{
  meta: { currency: "USD", exchangeTimezoneName: "UTC" },
  timestamp: close.map((_, index) => NOW / 1000 - (close.length - index) * 300),
  indicators: { quote: [{ close }] },
}] } });
const candle = (time: number) => ({ candle_date_time_utc: new Date(time).toISOString().slice(0, 19), trade_price: 100 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("translates a cache hint without modifying the URL, headers, signal or caller options", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
  vi.stubGlobal("fetch", fetch);
  const input = new URL("https://market.test/prices?symbol=AAPL");
  const init: RequestInit = { method: "GET", headers: { "User-Agent": "fixture" }, signal: new AbortController().signal };
  const response = await cloudflareMarketFetch(input, init, 300);
  expect(await response.text()).toBe("ok");
  expect(fetch).toHaveBeenCalledWith(input, { ...init, cf: { cacheTtl: 300, cacheEverything: true } });
  expect(init).not.toHaveProperty("cf");
});

it("passes requests without a cache hint through without adding cache overrides", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response("ok"));
  vi.stubGlobal("fetch", fetch);
  const init: RequestInit = { method: "POST", body: "fixture" };
  await cloudflareMarketFetch("https://market.test/token", init);
  expect(fetch.mock.calls[0][1]).toBe(init);
  expect(fetch.mock.calls[0][1]).not.toHaveProperty("cf");
});

it("uses only standard fetch options by default for both providers", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    return Response.json(url.hostname.includes("yahoo")
      ? url.pathname.includes("/chart/") ? chart() : { quotes: [] }
      : url.pathname.includes("/candles/") ? [candle(NOW), candle(NOW - 86_400_000)] : []);
  });
  const providers = createProviders();
  vi.stubGlobal("fetch", fetch);
  await getPrices("AAPL", { ticker: "AAPL", range: "1m" }, providers);
  await getPrices("KRW-BTC", { ticker: "KRW-BTC", range: "max" }, providers);
  await searchRemote("btc", providers);
  await providers[0].search("비트코인");
  expect(fetch).toHaveBeenCalledTimes(4);
  for (const call of fetch.mock.calls) {
    expect(call).toHaveLength(2);
    expect(call[1] ?? {}).not.toHaveProperty("cf");
    expect(call[1] ?? {}).not.toHaveProperty("cacheTtlSeconds");
  }
});

it("keeps injected HTTP clients separate between provider instances", async () => {
  const firstFetch = vi.fn(async () => Response.json(chart([1, 2])));
  const secondFetch = vi.fn(async () => Response.json(chart([10, 20])));
  const first = createYahoo(firstFetch);
  const second = createYahoo(secondFetch);
  expect((await first.getPrices("AAPL", { ticker: "AAPL", range: "1m" })).bars.at(-1)?.c).toBe(2);
  expect((await second.getPrices("AAPL", { ticker: "AAPL", range: "1m" })).bars.at(-1)?.c).toBe(20);
  expect(firstFetch).toHaveBeenCalledTimes(1);
  expect(secondFetch).toHaveBeenCalledTimes(1);
});

it("preserves Yahoo TTLs and headers for the original chart, session fallback and search", async () => {
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    return Response.json(url.pathname.includes("/search") ? { quotes: [] } : chart(url.searchParams.get("range") === "1d" ? [] : [100, 101]));
  });
  vi.stubGlobal("fetch", fetch);
  const providers = createProviders({ marketFetch: cloudflareMarketFetch });
  const series = await getPrices("AAPL", { ticker: "AAPL", range: "1d" }, providers);
  expect(series.bars).toHaveLength(2);
  await searchRemote("apple", providers);
  expect(fetch.mock.calls.map((call) => call[1]?.cf?.cacheTtl)).toEqual([300, 300, 3600]);
  expect(fetch.mock.calls.slice(0, 2).map((call) => new URL(String(call[0])).searchParams.get("range"))).toEqual(["1d", "5d"]);
  for (const call of fetch.mock.calls) {
    expect(call[1]?.headers).toEqual({ "User-Agent": "Mozilla/5.0 stock-chart-bot" });
    expect(call[1]?.cf?.cacheEverything).toBe(true);
    expect(new URL(String(call[0])).hostname).toBe("query1.finance.yahoo.com");
  }
});

it("preserves Upbit TTLs for every candle page, previous close and Korean market search", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/market/")) return Response.json([{ market: "KRW-BTC", korean_name: "비트코인" }]);
    if (url.pathname.endsWith("/days")) return Response.json([{ ...candle(NOW), prev_closing_price: 95 }]);
    const cursor = url.searchParams.get("to");
    const base = cursor ? Date.parse(cursor) - 300_000 : NOW;
    return Response.json(Array.from({ length: Number(url.searchParams.get("count")) }, (_, index) => candle(base - index * 300_000)));
  });
  vi.stubGlobal("fetch", fetch);
  const providers = createProviders({ marketFetch: cloudflareMarketFetch });
  const series = await getPrices("KRW-BTC", { ticker: "KRW-BTC", range: "1d" }, providers);
  expect(series.bars).toHaveLength(288);
  expect(series.previousClose).toBe(95);
  expect(await providers[0].search("bitcoin")).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(3);
  expect(await providers[0].search("비트코인")).toEqual([{ name: "비트코인 (KRW-BTC, Upbit)", value: "KRW-BTC" }]);
  expect(fetch.mock.calls.map((call) => call[1]?.cf?.cacheTtl)).toEqual([60, 60, 60, 3600]);
  expect(fetch.mock.calls.slice(0, 2).map((call) => new URL(String(call[0])).searchParams.get("count"))).toEqual(["200", "88"]);
  expect(fetch.mock.calls.every((call) => new URL(String(call[0])).hostname === "api.upbit.com")).toBe(true);
});

it("keeps KIS authentication and quote requests on the existing uncached transport", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetch = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => Response.json(
    String(input).includes("/oauth2/") ? { access_token: "fixture", expires_in: 86_400 } : {
      rt_cd: "0", output2: [
        { stck_bsop_date: "20260912", stck_clpr: "100" },
        { stck_bsop_date: "20260911", stck_clpr: "101" },
      ],
    },
  ));
  vi.stubGlobal("fetch", fetch);
  const marketFetch = vi.fn(async () => { throw new Error("unexpected cached transport"); });
  const providers = createProviders({ kisAppKey: "key", kisAppSecret: "secret", marketFetch });
  expect((await getPrices("005930.KS", { ticker: "005930.KS", range: "1m" }, providers)).source).toBe("한국투자증권");
  expect(marketFetch).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every((call) => !call[1]?.cf)).toBe(true);
});
