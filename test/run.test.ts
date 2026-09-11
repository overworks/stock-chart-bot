import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChart } from "../src/core/run";
import { resetSymbolCache, SYMBOLS_KEY } from "../src/core/symbols";

const ENV = env as unknown as Env;

const series = {
  chart: {
    result: [
      {
        meta: { exchangeTimezoneName: "Asia/Seoul", currency: "KRW" },
        timestamp: Array.from({ length: 10 }, (_, i) => 1_700_000_000 + i * 86_400),
        indicators: { quote: [{ close: Array.from({ length: 10 }, (_, i) => 100 + i) }] },
      },
    ],
  },
};
const notFound = { chart: { result: null, error: { code: "Not Found" } } };

function stub(handler: (url: URL) => unknown) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      return new Response(JSON.stringify(handler(url)));
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetSymbolCache();
});

describe("runChart", () => {
  it("uses the KV alias directly", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "삼성전자", value: "005930.KS" }]));
    const urls = stub(() => series);
    const msg = await runChart({ ticker: "삼성전자", range: "1m" }, ENV);
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/005930.KS"]);
    expect(msg.text).toBe("**삼성전자 (005930.KS)** 1m · 109 KRW ▲ +9 (+9.00%)");
    expect(msg.color).toBe("#dc2626");
    expect(msg.source).toBe("Yahoo Finance");
    expect(msg.image?.png.length).toBeGreaterThan(1000);
  });

  it("titles by name from Yahoo meta when the symbol is not in KV, and uses previous close for 1d", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([]));
    stub(() => ({
      chart: {
        result: [
          {
            meta: { exchangeTimezoneName: "America/New_York", currency: "USD", shortName: "Apple Inc.", chartPreviousClose: 100 },
            timestamp: [1, 2, 3],
            indicators: { quote: [{ close: [101, 102, 103] }] },
          },
        ],
      },
    }));
    const msg = await runChart({ ticker: "AAPL" }, ENV);
    expect(msg.text).toBe("**Apple Inc. (AAPL)** 1d · 103.00 USD ▲ +3.00 (+3.00%)");
  });

  it("uses the first bar as reference outside 1d even if previous close exists", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "애플", value: "AAPL" }]));
    stub(() => ({
      chart: {
        result: [
          {
            meta: { currency: "USD", chartPreviousClose: 50 },
            timestamp: [1, 2, 3],
            indicators: { quote: [{ close: [100, 102, 104] }] },
          },
        ],
      },
    }));
    const msg = await runChart({ ticker: "AAPL", range: "1m" }, ENV);
    expect(msg.text).toBe("**애플 (AAPL)** 1m · 104.00 USD ▲ +4.00 (+4.00%)");
  });

  it("scales JPY/KRW to 100 yen and says so in the title", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "엔/원", value: "JPYKRW=X" }, { key: "엔화", value: "JPYKRW=X" }]));
    stub(() => ({
      chart: {
        result: [
          {
            meta: { currency: "KRW", instrumentType: "CURRENCY", chartPreviousClose: 8.716, exchangeTimezoneName: "Europe/London" },
            timestamp: [1, 2, 3],
            indicators: { quote: [{ close: [8.7, 8.71, 8.697], open: [8.7, 8.7, 8.71], high: [8.72, 8.72, 8.72], low: [8.69, 8.69, 8.69] }] },
          },
        ],
      },
    }));
    const msg = await runChart({ ticker: "엔화" }, ENV);
    expect(msg.text).toBe("**엔/원 (JPYKRW=X, 100엔)** 1d · 869.70 KRW ▼ -1.90 (-0.22%)");
  });

  it("falls back to Yahoo search when an ASCII ticker is unknown", async () => {
    const urls = stub((u) => {
      if (u.pathname.endsWith("/chart/hynix")) return notFound;
      if (u.pathname.endsWith("/finance/search")) return { quotes: [{ symbol: "000660.KS", shortname: "SK hynix", quoteType: "EQUITY" }] };
      return series;
    });
    const msg = await runChart({ ticker: "hynix", range: "1y" }, ENV);
    expect(urls.map((u) => u.pathname)).toEqual([
      "/v8/finance/chart/hynix",
      "/v1/finance/search",
      "/v8/finance/chart/000660.KS",
    ]);
    expect(msg.text).toBe("**000660.KS** 1y · 109 KRW ▲ +9 (+9.00%)");
  });

  it("surfaces the original error when search finds nothing", async () => {
    stub((u) => (u.pathname.endsWith("/finance/search") ? { quotes: [] } : notFound));
    await expect(runChart({ ticker: "zzzz" }, ENV)).rejects.toThrow("'zzzz' 시세를 찾지 못했습니다.");
  });

  it("does not search for Hangul tickers that miss KV", async () => {
    const urls = stub(() => notFound);
    await expect(runChart({ ticker: "없는종목" }, ENV)).rejects.toThrow("찾지 못했습니다");
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/%EC%97%86%EB%8A%94%EC%A2%85%EB%AA%A9"]);
  });
});
