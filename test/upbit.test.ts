import { afterEach, describe, expect, it, vi } from "vitest";
import { upbit } from "../src/core/providers/upbit";
import { getPrices, searchRemote, SymbolNotFoundError } from "../src/core/market";

function candle(utc: string, price: number, extra: Record<string, unknown> = {}) {
  return { candle_date_time_utc: utc, opening_price: price - 1, high_price: price + 1, low_price: price - 2, trade_price: price, candle_acc_trade_volume: 5, ...extra };
}

function stub(handler: (url: URL) => { status?: number; body: unknown }) {
  const urls: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      urls.push(url);
      const { status = 200, body } = handler(url);
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }),
  );
  return urls;
}

afterEach(() => vi.unstubAllGlobals());

describe("upbit provider", () => {
  it("only claims KRW markets", () => {
    expect(upbit.supports!("KRW-BTC")).toBe(true);
    expect(upbit.supports!("BTC-USD")).toBe(false);
    expect(upbit.supports!("BTC-ETH")).toBe(false);
    expect(upbit.supports!("005930.KS")).toBe(false);
  });

  it("maps day candles newest-first into ascending bars with KST/KRW metadata", async () => {
    const urls = stub(() => ({
      body: [candle("2026-09-12T00:00:00", 105), candle("2026-09-11T00:00:00", 100)],
    }));
    const s = await upbit.getPrices("KRW-BTC", { ticker: "KRW-BTC", range: "1m" });
    expect(urls[0].pathname).toBe("/v1/candles/days");
    expect(urls[0].searchParams.get("market")).toBe("KRW-BTC");
    expect(urls[0].searchParams.get("count")).toBe("30");
    expect(s.bars).toEqual([
      { t: Date.parse("2026-09-11T00:00:00Z") / 1000, c: 100, o: 99, h: 101, l: 98, v: 5 },
      { t: Date.parse("2026-09-12T00:00:00Z") / 1000, c: 105, o: 104, h: 106, l: 103, v: 5 },
    ]);
    expect(s).toMatchObject({ label: "1m", intraday: false, timeZone: "Asia/Seoul", currency: "KRW", source: "Upbit", continuous: true });
    expect(s.previousClose).toBeUndefined();
  });

  it("pages 5-minute candles for 1d and takes the previous close from the day candle", async () => {
    let page = 0;
    const urls = stub((u) => {
      if (u.pathname.endsWith("/days")) return { body: [candle("2026-09-12T00:00:00", 100, { prev_closing_price: 95 })] };
      page++;
      const n = Number(u.searchParams.get("count"));
      const base = page === 1 ? Date.parse("2026-09-12T12:00:00Z") : Date.parse(u.searchParams.get("to")!);
      return { body: Array.from({ length: n }, (_, i) => candle(new Date(base - (i + (page === 1 ? 0 : 1)) * 300_000).toISOString().slice(0, 19), 100 + i)) };
    });
    const s = await upbit.getPrices("KRW-BTC", { ticker: "KRW-BTC", range: "1d" });
    const minute = urls.filter((u) => u.pathname.includes("/minutes/5"));
    expect(minute.map((u) => u.searchParams.get("count"))).toEqual(["200", "88"]);
    expect(minute[1].searchParams.get("to")).toMatch(/Z$/);
    expect(s.bars).toHaveLength(288);
    expect(s.bars[0].t).toBeLessThan(s.bars[287].t);
    expect(new Set(s.bars.map((b) => b.t)).size).toBe(288);
    expect(s.intraday).toBe(true);
    expect(s.previousClose).toBe(95);
  });

  it("uses day candles bounded by `to` for custom ranges and drops bars before `from`", async () => {
    const urls = stub(() => ({
      body: [candle("2026-03-03T00:00:00", 3), candle("2026-03-02T00:00:00", 2), candle("2026-03-01T00:00:00", 1), candle("2026-02-28T00:00:00", 0)],
    }));
    const s = await upbit.getPrices("KRW-ETH", { ticker: "x", from: "2026-03-01", to: "2026-03-03" });
    expect(urls[0].searchParams.get("count")).toBe("3");
    expect(urls[0].searchParams.get("to")).toBe("2026-03-04T00:00:00Z");
    expect(s.bars.map((b) => b.c)).toEqual([1, 2, 3]);
    expect(s.label).toBe("2026-03-01 ~ 2026-03-03");
  });

  it("turns 404 into SymbolNotFoundError and other failures into plain errors", async () => {
    stub(() => ({ status: 404, body: { error: { name: 404, message: "Code not found" } } }));
    await expect(upbit.getPrices("KRW-NOPE", { ticker: "x", range: "1m" })).rejects.toBeInstanceOf(SymbolNotFoundError);
    stub(() => ({ status: 429, body: {} }));
    await expect(upbit.getPrices("KRW-BTC", { ticker: "x", range: "1m" })).rejects.toThrow("요청 한도");
    stub(() => ({ body: "<html>" }));
    await expect(upbit.getPrices("KRW-BTC", { ticker: "x", range: "1m" })).rejects.toThrow("해석하지 못했습니다");
    stub(() => ({ body: [candle("2026-09-12T00:00:00", 1)] }));
    await expect(upbit.getPrices("KRW-BTC", { ticker: "x", range: "1m" })).rejects.toThrow("데이터가 부족");
  });

  it("searches Korean names and full market codes only", async () => {
    const urls = stub(() => ({
      body: [
        { market: "KRW-BTC", korean_name: "비트코인", english_name: "Bitcoin" },
        { market: "BTC-ETH", korean_name: "이더리움", english_name: "Ethereum" },
        { market: "KRW-ETH", korean_name: "이더리움", english_name: "Ethereum" },
      ],
    }));
    expect(await upbit.search("bitcoin")).toEqual([]);
    expect(urls).toHaveLength(0);
    expect(await upbit.search("이더")).toEqual([{ name: "이더리움 (KRW-ETH, Upbit)", value: "KRW-ETH" }]);
    expect(await upbit.search("krw-btc")).toEqual([{ name: "비트코인 (KRW-BTC, Upbit)", value: "KRW-BTC" }]);
  });
});

describe("provider routing", () => {
  it("sends KRW markets to Upbit and everything else to Yahoo", async () => {
    const urls = stub((u) => {
      if (u.hostname === "api.upbit.com") return { body: [candle("2026-09-12T00:00:00", 2), candle("2026-09-11T00:00:00", 1)] };
      return { body: { chart: { result: [{ meta: { currency: "USD" }, timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } } };
    });
    expect((await getPrices("KRW-BTC", { ticker: "x", range: "1m" })).source).toBe("Upbit");
    expect((await getPrices("BTC-USD", { ticker: "x", range: "1m" })).source).toBe("Yahoo Finance");
    expect(urls.map((u) => u.hostname)).toEqual(["api.upbit.com", "query1.finance.yahoo.com"]);
  });

  it("keeps ASCII remote search on Yahoo", async () => {
    const urls = stub(() => ({ body: { quotes: [{ symbol: "BTC-USD", shortname: "Bitcoin USD", quoteType: "CRYPTOCURRENCY" }] } }));
    expect((await searchRemote("btc"))[0].value).toBe("BTC-USD");
    expect(urls.map((u) => u.hostname)).toEqual(["query1.finance.yahoo.com"]);
  });
});
