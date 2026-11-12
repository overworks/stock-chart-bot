import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTitle, runChart } from "../src/core/run";
import { resetSymbolCache, SYMBOLS_KEY } from "../src/core/symbols";
import { captureLogs } from "./logs";
import { PROVIDERS } from "./providers";

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
      const body = handler(url);
      const status = body === notFound ? 404 : 200;
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetSymbolCache();
});

describe("runChart", () => {
  it("uses the KV alias directly", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "삼성전자", value: "005930.KS" }]));
    const urls = stub(() => series);
    const msg = await runChart({ ticker: "삼성전자", range: "1m" }, ENV, PROVIDERS);
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/005930.KS"]);
    expect(msg.text).toBe("**삼성전자 (005930.KS)** 1m · 109 KRW ▲ +9 (+9.00%)");
    expect(msg.color).toBe("#dc2626");
    expect(msg.source).toBe("Yahoo Finance");
    expect(msg.image?.png.length).toBeGreaterThan(1000);
  });

  it("titles by name from Yahoo meta when the symbol is not in KV, and uses previous close for 1d", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([]));
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
    const msg = await runChart({ ticker: "AAPL" }, ENV, PROVIDERS);
    expect(msg.text).toBe("**Apple Inc. (AAPL)** 1d · 103.00 USD ▲ +3.00 (+3.00%)");
  });

  it("uses the first bar as reference outside 1d even if previous close exists", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "애플", value: "AAPL" }]));
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
    const msg = await runChart({ ticker: "AAPL", range: "1m" }, ENV, PROVIDERS);
    expect(msg.text).toBe("**애플 (AAPL)** 1m · 104.00 USD ▲ +4.00 (+4.00%)");
  });

  it("scales JPY/KRW to 100 yen and says so in the title", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "엔/원", value: "JPYKRW=X" }, { key: "엔화", value: "JPYKRW=X" }]));
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
    const msg = await runChart({ ticker: "엔화" }, ENV, PROVIDERS);
    expect(msg.text).toBe("**엔/원 (JPYKRW=X, 100엔)** 1d · 869.70 KRW ▼ -1.90 (-0.22%)");
  });

  it("shows indices without a currency unit", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "나스닥", value: "^IXIC" }]));
    stub(() => ({
      chart: {
        result: [
          {
            meta: { exchangeTimezoneName: "America/New_York", currency: "USD" },
            timestamp: [1, 2, 3],
            indicators: { quote: [{ close: [2500, 2510.5, 2525.25] }] },
          },
        ],
      },
    }));
    const msg = await runChart({ ticker: "나스닥", range: "1m" }, ENV, PROVIDERS);
    expect(msg.text).toBe("**나스닥 (^IXIC)** 1m · 2,525.25 ▲ +25.25 (+1.01%)");
  });

  it("falls back to Yahoo search when an ASCII ticker is unknown", async () => {
    const logs = captureLogs();
    const urls = stub((u) => {
      if (u.pathname.endsWith("/chart/hynix")) return notFound;
      if (u.pathname.endsWith("/finance/search")) return { quotes: [{ symbol: "000660.KS", shortname: "SK hynix", quoteType: "EQUITY" }] };
      return series;
    });
    const msg = await runChart({ ticker: "hynix", range: "1y" }, ENV, PROVIDERS);
    expect(urls.map((u) => u.pathname)).toEqual([
      "/v8/finance/chart/hynix",
      "/v1/finance/search",
      "/v8/finance/chart/000660.KS",
    ]);
    expect(msg.text).toBe("**000660.KS** 1y · 109 KRW ▲ +9 (+9.00%)");
    expect(logs("chart_served")).toEqual([expect.objectContaining({ ticker: "hynix", symbol: "000660.KS", resolved: "search" })]);
  });

  it("logs why a chart failed and reserves the error level for upstream faults", async () => {
    const logs = captureLogs();
    await expect(runChart({ ticker: " " }, ENV, PROVIDERS)).rejects.toThrow("종목");
    await expect(runChart({ ticker: "AAPL", from: "2026-01-01" }, ENV, PROVIDERS)).rejects.toThrow("함께");
    stub((u) => (u.pathname.endsWith("/finance/search") ? { quotes: [] } : notFound));
    await expect(runChart({ ticker: "zzzz" }, ENV, PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    stub(() => ({ chart: { result: [{ meta: {}, timestamp: [1], indicators: { quote: [{ close: [1] }] } }] } }));
    await expect(runChart({ ticker: "AAPL", range: "1m" }, ENV, PROVIDERS)).rejects.toThrow("부족");
    expect(logs("chart_failed").map((e) => [e.level, e.reason, e.ticker])).toEqual([
      ["warn", "invalid_args", " "],
      ["warn", "invalid_args", "AAPL"],
      ["warn", "not_found", "zzzz"],
      ["error", "upstream", "AAPL"],
    ]);
  });

  it("surfaces the original error when search finds nothing", async () => {
    stub((u) => (u.pathname.endsWith("/finance/search") ? { quotes: [] } : notFound));
    await expect(runChart({ ticker: "zzzz" }, ENV, PROVIDERS)).rejects.toThrow("'zzzz' 시세를 찾지 못했습니다.");
  });

  it("does not search when KV resolved the alias, even if the symbol is missing upstream", async () => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "LG", value: "003550.KS" }]));
    const urls = stub(() => notFound);
    await expect(runChart({ ticker: "LG" }, ENV, PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/003550.KS"]);
  });

  it("does not search when the error is 'not enough data'", async () => {
    const urls = stub(() => ({ chart: { result: [{ meta: {}, timestamp: [1], indicators: { quote: [{ close: [1] }] } }] } }));
    await expect(runChart({ ticker: "AAPL" }, ENV, PROVIDERS)).rejects.toThrow("부족");
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/AAPL", "/v8/finance/chart/AAPL"]);
    expect(urls.map((u) => u.searchParams.get("range"))).toEqual(["1d", "5d"]);
  });

  it("does not search for Hangul tickers that miss KV", async () => {
    const urls = stub(() => notFound);
    await expect(runChart({ ticker: "없는종목" }, ENV, PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    expect(urls.map((u) => u.pathname)).toEqual(["/v8/finance/chart/%EC%97%86%EB%8A%94%EC%A2%85%EB%AA%A9"]);
  });
});

describe("buildTitle", () => {
  it("handles every combination of name and display label", () => {
    expect(buildTitle("005930.KS", "삼성전자")).toBe("삼성전자 (005930.KS)");
    expect(buildTitle("JPYKRW=X", "JPY/KRW", "100엔")).toBe("JPY/KRW (JPYKRW=X, 100엔)");
    expect(buildTitle("JPYKRW=X", undefined, "100엔")).toBe("JPYKRW=X (100엔)");
    expect(buildTitle("JPYKRW=X", "JPYKRW=X", "100엔")).toBe("JPYKRW=X (100엔)");
    expect(buildTitle("AAPL")).toBe("AAPL");
    expect(buildTitle("AAPL", "AAPL")).toBe("AAPL");
  });
});
