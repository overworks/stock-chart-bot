import type { Env } from "../cloudflare/env";
import { createSymbolStore, ALIASES_KEY, SYMBOLS_KEY } from "../cloudflare/storage";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAlias, listAliases, removeAlias, runAlias, searchAliases } from "../src/core/aliases";
import { resetSymbolCache, resolveSymbol, searchSymbols, symbolName } from "../src/core/symbols";
import { captureLogs } from "./logs";
import { PROVIDERS } from "./providers";

const KV = (env as unknown as Env).KV;
const WRITER = (env as unknown as Env).ALIAS_WRITER;
const STORE = createSymbolStore(env as unknown as Env);

const series = {
  chart: {
    result: [
      {
        meta: { currency: "USD", shortName: "Palantir Technologies" },
        timestamp: [1, 2, 3],
        indicators: { quote: [{ close: [10, 11, 12] }] },
      },
    ],
  },
};
const notFound = { chart: { result: null, error: { code: "Not Found" } } };

function stub(handler: (url: URL) => unknown) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const body = handler(new URL(String(input)));
    return new Response(JSON.stringify(body), { status: body === notFound ? 404 : 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(async () => {
  resetSymbolCache();
  const stub = WRITER.get(WRITER.idFromName(ALIASES_KEY));
  await runInDurableObject(stub, async (_, state) => state.storage.deleteAll());
  await KV.delete(ALIASES_KEY);
  await KV.put(
    SYMBOLS_KEY,
    JSON.stringify([
      { key: "달러/원", value: "KRW=X" },
      { key: "달러", value: "KRW=X", alias: true },
      { key: "삼전", value: "005930.KS", alias: true },
      { key: "삼성전자", value: "005930.KS" },
      { key: "삼성전자우", value: "005935.KS" },
      { key: "SK하이닉스", value: "000660.KS" },
    ]),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("seeded aliases", () => {
  it("match in search but display the canonical name", async () => {
    stub(() => ({ quotes: [] }));
    expect(await searchSymbols("삼전", STORE, PROVIDERS)).toEqual([{ name: "삼성전자 (005930.KS)", value: "005930.KS" }]);
    expect((await searchSymbols("달러", STORE, PROVIDERS))[0]).toEqual({ name: "달러/원 (KRW=X)", value: "KRW=X" });
    expect(await symbolName("005930.KS", STORE)).toBe("삼성전자");
    expect(await resolveSymbol("삼전", STORE)).toBe("005930.KS");
  });

  it("ignores list position when picking the canonical name", async () => {
    await KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "별칭", value: "X", alias: true }, { key: "정식", value: "X" }]));
    resetSymbolCache();
    expect(await symbolName("X", STORE)).toBe("정식");
    await KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "별칭만", value: "Y", alias: true }]));
    resetSymbolCache();
    expect(await symbolName("Y", STORE)).toBe("별칭만");
  });
});

describe("user aliases", () => {
  it("preserves concurrent additions and mixed additions/removals", async () => {
    stub(() => ({ quotes: [] }));
    await Promise.all([
      addAlias(STORE, "별칭A", "삼성전자", PROVIDERS),
      addAlias(STORE, "별칭B", "SK하이닉스", PROVIDERS),
    ]);
    expect(await listAliases(STORE)).toEqual(expect.arrayContaining([
      { key: "별칭A", value: "005930.KS" },
      { key: "별칭B", value: "000660.KS" },
    ]));
    await Promise.all([
      removeAlias("별칭A", STORE),
      addAlias(STORE, "별칭C", "삼성전자", PROVIDERS),
    ]);
    expect((await listAliases(STORE)).map((entry) => entry.key).sort()).toEqual(["별칭B", "별칭C"]);
  });

  it("adds an alias by exact name, resolves it, and shows the canonical name", async () => {
    const fn = stub(() => ({ quotes: [] }));
    const r = await addAlias(STORE, " 하닉 ", "SK하이닉스", PROVIDERS);
    expect(r).toEqual({ alias: "하닉", symbol: "000660.KS", display: "SK하이닉스 (000660.KS)" });
    expect(await listAliases(STORE)).toEqual([{ key: "하닉", value: "000660.KS" }]);
    expect(await resolveSymbol("하닉", STORE)).toBe("000660.KS");
    expect(await searchSymbols("하닉", STORE, PROVIDERS)).toEqual([{ name: "SK하이닉스 (000660.KS)", value: "000660.KS" }]);
    expect(await symbolName("000660.KS", STORE)).toBe("SK하이닉스");
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts a partial name via search and a raw symbol via a quote lookup", async () => {
    const fn = stub((u) => (u.pathname.includes("/chart/PLTR") ? series : u.pathname.includes("/chart/") ? notFound : { quotes: [] }));
    expect((await addAlias(STORE, "삼우", "삼성전자우", PROVIDERS)).display).toBe("삼성전자우 (005935.KS)");
    expect(await addAlias(STORE, "팔란티어", "PLTR", PROVIDERS)).toEqual({ alias: "팔란티어", symbol: "PLTR", display: "Palantir Technologies (PLTR)" });
    expect(fn.mock.calls.some((c) => String(c[0]).includes("/chart/PLTR"))).toBe(true);
    await expect(addAlias(STORE, "없음", "NOPE.XX", PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    await expect(addAlias(STORE, "없음", "ZZZZ", PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    await expect(addAlias(STORE, "없음", "존재하지않는회사", PROVIDERS)).rejects.toThrow("찾지 못했습니다");
    expect(await symbolName("PLTR", STORE)).toBe("팔란티어");
  });

  it("rejects symbol-shaped aliases and names already used by the seed list, but allows overwriting its own", async () => {
    stub(() => ({ quotes: [] }));
    await expect(addAlias(STORE, "005930.KS", "삼성전자", PROVIDERS)).rejects.toThrow("심볼 형식");
    await expect(addAlias(STORE, "삼성전자", "SK하이닉스", PROVIDERS)).rejects.toThrow("이미 종목명");
    await expect(addAlias(STORE, "삼전", "SK하이닉스", PROVIDERS)).rejects.toThrow("이미 종목명");
    await addAlias(STORE, "하닉", "삼성전자", PROVIDERS);
    await addAlias(STORE, "하닉", "SK하이닉스", PROVIDERS);
    expect(await listAliases(STORE)).toEqual([{ key: "하닉", value: "000660.KS" }]);
    await expect(addAlias(STORE, "", "삼성전자", PROVIDERS)).rejects.toThrow("사용법");
  });

  it.each(["T", "AM", "ETH", "USD"])("prefers the exact ticker %s over local prefix matches", async (target) => {
    await KV.put(SYMBOLS_KEY, JSON.stringify([
      { key: "TP", value: "007980.KS" },
      { key: "아마존", value: "AMZN" },
      { key: "이더리움/달러", value: "ETH-USD" },
      { key: "USDKRW", value: "KRW=X" },
    ]));
    const fetch = stub(() => series);
    expect((await addAlias(STORE, "검증별칭", target, PROVIDERS)).symbol).toBe(target);
    expect(await listAliases(STORE)).toEqual([{ key: "검증별칭", value: target }]);
    expect(fetch.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([`/v8/finance/chart/${target}`]);
  });

  it("searches names only after a not-found response, preserving upstream errors", async () => {
    const fetch = stub((url) => url.pathname.includes("/chart/") ? notFound : {
      quotes: [{ symbol: "TSLA", shortname: "Tesla, Inc.", quoteType: "EQUITY" }],
    });
    expect((await addAlias(STORE, "테슬라별칭", "Tesla", PROVIDERS)).symbol).toBe("TSLA");
    expect(fetch.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      "/v8/finance/chart/Tesla", "/v1/finance/search",
    ]);
    const unavailable = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", unavailable);
    await expect(addAlias(STORE, "잘못된별칭", "AM", PROVIDERS)).rejects.toThrow("503");
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect((await listAliases(STORE)).some((entry) => entry.key === "잘못된별칭")).toBe(false);
  });

  it("removes aliases and reports missing ones", async () => {
    stub(() => ({ quotes: [] }));
    await addAlias(STORE, "하닉", "SK하이닉스", PROVIDERS);
    expect(await removeAlias("하닉", STORE)).toEqual({ key: "하닉", value: "000660.KS" });
    expect(await listAliases(STORE)).toEqual([]);
    expect(await resolveSymbol("하닉", STORE)).toBe("하닉");
    await expect(removeAlias("하닉", STORE)).rejects.toThrow("별칭이 없습니다");
  });

  it("runAlias formats add/remove/list and autocompletes aliases", async () => {
    const logs = captureLogs();
    stub(() => ({ quotes: [] }));
    expect(await runAlias({ action: "list" }, STORE, PROVIDERS)).toBe("등록된 별칭이 없습니다.");
    expect(await runAlias({ action: "add", alias: "하닉", target: "SK하이닉스" }, STORE, PROVIDERS)).toBe("✅ 별칭 추가: 하닉 → SK하이닉스 (000660.KS)");
    expect(await runAlias({ action: "list" }, STORE, PROVIDERS)).toBe("• 하닉 → SK하이닉스 (000660.KS)");
    expect(await searchAliases("하", STORE)).toEqual([{ name: "하닉 → SK하이닉스 (000660.KS)", value: "하닉" }]);
    expect(await searchAliases("zz", STORE)).toEqual([]);
    expect(await runAlias({ action: "remove", alias: "하닉" }, STORE, PROVIDERS)).toBe("🗑️ 별칭 삭제: 하닉 → 000660.KS");
    await expect(runAlias({ action: "bogus" }, STORE, PROVIDERS)).rejects.toThrow("사용법");
    expect(logs("chart.alias.changed")).toEqual([
      { level: "log", message: "chart.alias.changed", "chart.alias.action": "add", "chart.alias.name": "하닉", "chart.symbol": "000660.KS" },
      { level: "log", message: "chart.alias.changed", "chart.alias.action": "remove", "chart.alias.name": "하닉", "chart.symbol": "000660.KS" },
    ]);
  });
});
