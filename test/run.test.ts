import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runChart } from "../src/core/run";
import { resetSymbolCache, SYMBOLS_KEY } from "../src/core/symbols";

const ENV = env as unknown as Env;

const series = {
  chart: {
    result: [
      {
        meta: { exchangeTimezoneName: "Asia/Seoul" },
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
    expect(msg.text).toBe("**삼성전자 (005930.KS)** 1m");
    expect(msg.image?.png.length).toBeGreaterThan(1000);
  });

  it("falls back to Yahoo search when an ASCII ticker is unknown", async () => {
    const urls = stub((u) => {
      if (u.pathname.endsWith("/chart/hynix")) return notFound;
      if (u.pathname.endsWith("/finance/search")) return { quotes: [{ symbol: "000660.KS", shortname: "SK hynix", quoteType: "EQUITY" }] };
      return series;
    });
    const msg = await runChart({ ticker: "hynix" }, ENV);
    expect(urls.map((u) => u.pathname)).toEqual([
      "/v8/finance/chart/hynix",
      "/v1/finance/search",
      "/v8/finance/chart/000660.KS",
    ]);
    expect(msg.text).toBe("**hynix (000660.KS)** 1y");
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
