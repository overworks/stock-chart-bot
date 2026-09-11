import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSymbolCache, resolveSymbol, searchSymbols, SYMBOLS_KEY } from "../src/core/symbols";
import { yahoo } from "../src/core/providers/yahoo";

const KV = (env as unknown as Env).SYMBOLS;

const yahooQuotes = {
  quotes: [
    { symbol: "SKHY", shortname: "SK hynix Inc.", exchDisp: "NASDAQ", quoteType: "EQUITY" },
    { symbol: "000660.KS", shortname: "SK hynix", exchDisp: "KSE", quoteType: "EQUITY" },
    { symbol: "SKHYNIX-NEWS", shortname: "news", quoteType: "NEWS" },
    { symbol: "HY9H.F", longname: "SK Hynix Inc.", exchange: "FRA", quoteType: "EQUITY" },
  ],
};

function stubYahoo(body: unknown = yahooQuotes, status = 200) {
  const fn = vi.fn(async (_i: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(async () => {
  resetSymbolCache();
  await KV.put(
    SYMBOLS_KEY,
    JSON.stringify([
      { key: "삼성전자", value: "005930.KS" },
      { key: "삼성전자우", value: "005935.KS" },
      { key: "삼성SDI", value: "006400.KS" },
      { key: "NAVER", value: "035420.KS" },
      { key: "SK하이닉스", value: "000660.KS" },
      { key: "애플", value: "AAPL" },
    ]),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("searchSymbols", () => {
  it("returns nothing for an empty query without touching the network", async () => {
    const fn = stubYahoo();
    expect(await searchSymbols("   ", KV)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("ranks exact, then prefix, then substring matches and never falls back for Hangul", async () => {
    const fn = stubYahoo();
    const out = await searchSymbols("삼성", KV);
    expect(out[0]).toEqual({ name: "삼성전자 (005930.KS)", value: "005930.KS" });
    expect(out.map((c) => c.value).slice(1).sort()).toEqual(["005935.KS", "006400.KS"]);
    expect((await searchSymbols("하이닉스", KV)).map((c) => c.value)).toEqual(["000660.KS"]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("matches names and symbols case-insensitively, ignoring spaces", async () => {
    stubYahoo({ quotes: [] });
    expect((await searchSymbols("nav", KV))[0]).toEqual({ name: "NAVER (035420.KS)", value: "035420.KS" });
    expect((await searchSymbols("0059", KV)).map((c) => c.value)).toEqual(["005930.KS", "005935.KS"]);
    expect((await searchSymbols("sk 하이닉스", KV)).map((c) => c.value)).toEqual(["000660.KS"]);
  });

  it("matches Hangul initial consonants, mixed with syllables, and ranks prefix first", async () => {
    const fn = stubYahoo();
    expect((await searchSymbols("ㅅㅅㅈㅈ", KV)).map((c) => c.value)).toEqual(["005930.KS", "005935.KS"]);
    expect((await searchSymbols("ㅅㅅ", KV))[0].value).toBe("005930.KS");
    expect((await searchSymbols("삼ㅅ", KV)).map((c) => c.value).sort()).toEqual(["005930.KS", "005935.KS", "006400.KS"]);
    expect((await searchSymbols("ㅎㅇㄴㅅ", KV)).map((c) => c.value)).toEqual(["000660.KS"]);
    expect((await searchSymbols("skㅎ", KV)).map((c) => c.value)).toEqual(["000660.KS"]);
    expect(await searchSymbols("ㅋㅋ", KV)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("falls back to Yahoo search for ASCII queries and dedupes against local hits", async () => {
    const fn = stubYahoo();
    const out = await searchSymbols("hynix", KV);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(new URL(String(fn.mock.calls[0]![0])).searchParams.get("q")).toBe("hynix");
    expect(out.map((c) => c.value)).toEqual(["SKHY", "000660.KS", "HY9H.F"]);
    expect(out[0].name).toBe("SK hynix Inc. (SKHY, NASDAQ)");
    expect(out[2].name).toBe("SK Hynix Inc. (HY9H.F, FRA)");
  });

  it("reads both KV keys once per cache window", async () => {
    const spy = vi.spyOn(KV, "get");
    await searchSymbols("삼성", KV);
    await searchSymbols("애플", KV);
    await resolveSymbol("삼성전자", KV);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("returns an empty list when the KV key is missing", async () => {
    resetSymbolCache();
    await KV.delete(SYMBOLS_KEY);
    stubYahoo({ quotes: [] });
    expect(await searchSymbols("삼성", KV)).toEqual([]);
    expect(await resolveSymbol("삼성전자", KV)).toBe("삼성전자");
  });

  it("skips the fallback for single-character ASCII queries", async () => {
    const fn = stubYahoo();
    await searchSymbols("h", KV);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("resolveSymbol", () => {
  it("maps aliases only on exact match and passes unknown tickers through", async () => {
    expect(await resolveSymbol("삼성전자", KV)).toBe("005930.KS");
    expect(await resolveSymbol("NAVER", KV)).toBe("035420.KS");
    expect(await resolveSymbol(" 애플 ", KV)).toBe("AAPL");
    expect(await resolveSymbol("naver", KV)).toBe("naver");
    expect(await resolveSymbol("TSLA", KV)).toBe("TSLA");
  });

  it("never remaps inputs that already look like Yahoo symbols", async () => {
    await KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "GS", value: "078930.KS" }, { key: "005930.KS", value: "WRONG" }, { key: "KRW=X", value: "WRONG" }]));
    resetSymbolCache();
    expect(await resolveSymbol("GS", KV)).toBe("078930.KS");
    expect(await resolveSymbol("005930.KS", KV)).toBe("005930.KS");
    expect(await resolveSymbol("KRW=X", KV)).toBe("KRW=X");
    expect(await resolveSymbol("BTC-USD", KV)).toBe("BTC-USD");
    expect(await resolveSymbol("^KS11", KV)).toBe("^KS11");
  });

  it("dedupes concurrent cold loads into one KV round trip", async () => {
    resetSymbolCache();
    const spy = vi.spyOn(KV, "get");
    await Promise.all([resolveSymbol("삼성전자", KV), resolveSymbol("NAVER", KV), searchSymbols("삼성", KV)]);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe("yahoo.search", () => {
  it("returns an empty list on http errors or network failures", async () => {
    stubYahoo({}, 500);
    expect(await yahoo.search("aapl")).toEqual([]);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await yahoo.search("aapl")).toEqual([]);
  });
});
