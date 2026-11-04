import { afterEach, describe, expect, it, vi } from "vitest";
import { getPrices, searchRemote, SymbolNotFoundError, type MarketProvider } from "../src/core/market";

function yahoo(body: unknown, status = 200) {
  const fn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return { url: () => new URL(String(fn.mock.calls[0]![0])) };
}

const ok = {
  chart: {
    result: [
      {
        meta: { exchangeTimezoneName: "Asia/Seoul", currency: "KRW", shortName: "SamsungElec", chartPreviousClose: 9.5, instrumentType: "EQUITY" },
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
    expect(series.source).toBe("Yahoo Finance");
    expect(series.continuous).toBe(false);
  });

  it.each([
    ["1d", "1d", "5m", "true"],
    ["1w", "5d", "30m", null],
    ["3m", "3mo", "1d", null],
    ["6m", "6mo", "1d", null],
    ["5y", "5y", "1wk", null],
    ["max", "max", "1mo", null],
  ])("range %s -> yahoo %s/%s (includePrePost %s)", async (range, yRange, interval, prePost) => {
    const fn = yahoo(ok);
    await getPrices("AAPL", { ticker: "AAPL", range });
    const url = fn.url();
    expect(url.searchParams.get("range")).toBe(yRange);
    expect(url.searchParams.get("interval")).toBe(interval);
    expect(url.searchParams.get("includePrePost")).toBe(prePost);
  });

  describe("1d previous close with extended hours", () => {
    // 2026-11-03 16:00 ET 정규장 마감, 2026-11-04 04:00·04:05 ET 프리마켓
    const close1103 = 1793739600;
    const pre1104 = [1793782800, 1793783100];
    const meta = { exchangeTimezoneName: "America/New_York", currency: "USD", instrumentType: "EQUITY" };
    const body = (m: object, timestamp: number[]) => ({ chart: { result: [{ meta: { ...meta, ...m }, timestamp, indicators: { quote: [{ close: [335, 337.82] }] } }] } });

    it("uses the last regular close during pre-market", async () => {
      yahoo(body({ chartPreviousClose: 338.32, previousClose: 338.32, regularMarketPrice: 331.9, regularMarketTime: close1103 }, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1d" })).previousClose).toBe(331.9);
    });

    it("keeps Yahoo's previous close once the regular session has traded", async () => {
      yahoo(body({ chartPreviousClose: 331.9, regularMarketPrice: 336, regularMarketTime: pre1104[1] + 6 * 3600 }, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1d" })).previousClose).toBe(331.9);
    });

    it("passes regular hours from either tradingPeriods shape on 1d only", async () => {
      const span = { timezone: "EST", start: 1793802600, end: 1793826000, gmtoffset: -18000 };
      const regularHours = [{ start: span.start, end: span.end }];
      yahoo(body({ tradingPeriods: { pre: [[{ ...span, start: 1 }]], regular: [[span]], post: [[{ ...span, end: 2 }]] } }, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1d" })).regularHours).toEqual(regularHours);
      yahoo(body({ tradingPeriods: [[span]] }, pre1104));
      expect((await getPrices("^GSPC", { ticker: "^GSPC", range: "1d" })).regularHours).toEqual(regularHours);
      yahoo(body({ tradingPeriods: [[span]] }, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1w" })).regularHours).toBeUndefined();
      yahoo(body({}, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1d" })).regularHours).toBeUndefined();
    });

    it("ignores the regular session time for other ranges", async () => {
      yahoo(body({ chartPreviousClose: 338.32, regularMarketPrice: 331.9, regularMarketTime: close1103 }, pre1104));
      expect((await getPrices("AAPL", { ticker: "AAPL", range: "1w" })).previousClose).toBe(338.32);
    });
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

  it("throws SymbolNotFoundError on Yahoo's 404 and on a null result", async () => {
    yahoo({ chart: { result: null, error: { code: "Not Found" } } }, 404);
    await expect(getPrices("NOPE", { ticker: "NOPE" })).rejects.toBeInstanceOf(SymbolNotFoundError);
    yahoo({ chart: { result: null } });
    await expect(getPrices("NOPE", { ticker: "NOPE" })).rejects.toThrow("찾지 못했습니다");
  });

  it("treats too few bars as a plain error, not as not-found", async () => {
    yahoo({ chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [1, null] }] } }] } });
    const err = await getPrices("AAPL", { ticker: "AAPL" }).catch((e) => e);
    expect(err.message).toContain("부족");
    expect(err).not.toBeInstanceOf(SymbolNotFoundError);
  });

  it("reports unparseable bodies instead of throwing SyntaxError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>consent</html>", { status: 200 })));
    await expect(getPrices("AAPL", { ticker: "AAPL" })).rejects.toThrow("해석하지");
  });

  it("flags intraday for minute intervals only", async () => {
    yahoo(ok);
    expect((await getPrices("AAPL", { ticker: "AAPL", range: "1d" })).intraday).toBe(true);
    yahoo(ok);
    expect((await getPrices("AAPL", { ticker: "AAPL", range: "1w" })).intraday).toBe(true);
    yahoo(ok);
    expect((await getPrices("AAPL", { ticker: "AAPL", range: "max" })).intraday).toBe(false);
    yahoo(ok);
    expect((await getPrices("AAPL", { ticker: "AAPL", from: "2024-01-01", to: "2024-02-01" })).intraday).toBe(false);
  });
});

describe("provider fallback", () => {
  const series = { bars: [{ t: 1, c: 1 }, { t: 2, c: 2 }], label: "1d", intraday: true, timeZone: "UTC", currency: "USD", source: "B" };
  const failing: MarketProvider = {
    name: "A",
    getPrices: async () => { throw new Error("시세 조회 실패 (503)"); },
    search: async () => [],
  };
  const missing: MarketProvider = {
    name: "A2",
    getPrices: async () => { throw new SymbolNotFoundError("'X' 시세를 찾지 못했습니다."); },
    search: async () => [],
  };
  const ok: MarketProvider = {
    name: "B",
    getPrices: async () => series,
    search: async () => [{ name: "X (X)", value: "X" }],
  };

  it("moves to the next provider on errors and on not-found", async () => {
    expect((await getPrices("X", { ticker: "X" }, [failing, ok])).source).toBe("B");
    expect((await getPrices("X", { ticker: "X" }, [missing, ok])).source).toBe("B");
  });

  it("rethrows the first error when every provider fails", async () => {
    await expect(getPrices("X", { ticker: "X" }, [failing, missing])).rejects.toThrow("503");
    await expect(getPrices("X", { ticker: "X" }, [])).rejects.toThrow("제공자");
  });

  it("returns the first non-empty search result and swallows provider errors", async () => {
    const throwing: MarketProvider = { name: "T", getPrices: async () => series, search: async () => { throw new Error("boom"); } };
    expect(await searchRemote("x", [failing, ok])).toEqual([{ name: "X (X)", value: "X" }]);
    expect(await searchRemote("x", [throwing, ok])).toEqual([{ name: "X (X)", value: "X" }]);
    expect(await searchRemote("x", [failing])).toEqual([]);
  });

  it("rejects a provider result with fewer than two bars", async () => {
    const thin: MarketProvider = { name: "thin", getPrices: async () => ({ ...series, bars: [{ t: 1, c: 1 }] }), search: async () => [] };
    await expect(getPrices("X", { ticker: "X" }, [thin])).rejects.toThrow("부족");
  });

  it("marks crypto and FX as continuous markets", async () => {
    yahoo({ chart: { result: [{ meta: { instrumentType: "CRYPTOCURRENCY", currency: "USD" }, timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } });
    expect((await getPrices("BTC-USD", { ticker: "BTC-USD" })).continuous).toBe(true);
  });
});
