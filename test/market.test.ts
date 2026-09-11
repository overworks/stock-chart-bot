import { afterEach, describe, expect, it, vi } from "vitest";
import { getPrices } from "../src/core/market";

function yahoo(body: unknown, status = 200) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return { url: () => new URL(String(fn.mock.calls[0]![0])) };
}

const ok = {
  chart: {
    result: [
      {
        meta: { exchangeTimezoneName: "Asia/Seoul", currency: "KRW", shortName: "SamsungElec", chartPreviousClose: 9.5 },
        timestamp: [1, 2, 3, 4],
        indicators: { quote: [{ close: [10, null, 12, 13], open: [9, 10, 11, null], high: [11, 11, 13, 14], low: [8, 9, 11, 12], volume: [100, 0, 300, 400] }] },
      },
    ],
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("getPrices", () => {
  it("maps user ranges to Yahoo range/interval and drops null closes", async () => {
    const fn = yahoo(ok);
    const series = await getPrices("005930.KS", { ticker: "x", range: "1m" });
    const url = fn.url();
    expect(url.pathname).toBe("/v8/finance/chart/005930.KS");
    expect(url.searchParams.get("range")).toBe("1mo");
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(series.bars).toEqual([
      { t: 1, c: 10, o: 9, h: 11, l: 8, v: 100 },
      { t: 3, c: 12, o: 11, h: 13, l: 11, v: 300 },
      { t: 4, c: 13, o: undefined, h: 14, l: 12, v: 400 },
    ]);
    expect(series.label).toBe("1m");
    expect(series.timeZone).toBe("Asia/Seoul");
    expect(series.currency).toBe("KRW");
    expect(series.name).toBe("SamsungElec");
    expect(series.previousClose).toBe(9.5);
  });

  it.each([
    ["1d", "1d", "5m"],
    ["1w", "5d", "30m"],
    ["3m", "3mo", "1d"],
    ["6m", "6mo", "1d"],
    ["5y", "5y", "1wk"],
    ["max", "max", "1mo"],
  ])("range %s -> yahoo %s/%s", async (range, yRange, interval) => {
    const fn = yahoo(ok);
    await getPrices("AAPL", { ticker: "AAPL", range });
    const url = fn.url();
    expect(url.searchParams.get("range")).toBe(yRange);
    expect(url.searchParams.get("interval")).toBe(interval);
  });

  it("uses period1/period2 for custom periods", async () => {
    const fn = yahoo(ok);
    const series = await getPrices("AAPL", { ticker: "AAPL", from: "2024-01-01", to: "2024-01-31" });
    const url = fn.url();
    expect(url.searchParams.get("period1")).toBe(String(Date.UTC(2024, 0, 1) / 1000));
    expect(url.searchParams.get("period2")).toBe(String(Date.UTC(2024, 1, 1) / 1000));
    expect(url.searchParams.get("interval")).toBe("1d");
    expect(series.label).toBe("2024-01-01 ~ 2024-01-31");
  });

  it("throws on http errors", async () => {
    yahoo({}, 429);
    await expect(getPrices("AAPL", { ticker: "AAPL" })).rejects.toThrow("429");
  });

  it("throws when the symbol is unknown", async () => {
    yahoo({ chart: { result: null, error: { code: "Not Found" } } });
    await expect(getPrices("NOPE", { ticker: "NOPE" })).rejects.toThrow("찾지 못했습니다");
  });

  it("throws when fewer than two bars remain", async () => {
    yahoo({ chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [1, null] }] } }] } });
    await expect(getPrices("AAPL", { ticker: "AAPL" })).rejects.toThrow("부족");
  });
});
