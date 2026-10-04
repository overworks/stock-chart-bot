import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addAlias, listAliases, removeAlias, runAlias, searchAliases } from "../src/core/aliases";
import { ALIASES_KEY, resetSymbolCache, resolveSymbol, searchSymbols, symbolName, SYMBOLS_KEY } from "../src/core/symbols";

const KV = (env as unknown as Env).KV;
const WRITER = (env as unknown as Env).ALIAS_WRITER;

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
afterEach(() => vi.unstubAllGlobals());

describe("seeded aliases", () => {
  it("match in search but display the canonical name", async () => {
    stub(() => ({ quotes: [] }));
    expect(await searchSymbols("삼전", KV)).toEqual([{ name: "삼성전자 (005930.KS)", value: "005930.KS" }]);
    expect((await searchSymbols("달러", KV))[0]).toEqual({ name: "달러/원 (KRW=X)", value: "KRW=X" });
    expect(await symbolName("005930.KS", KV)).toBe("삼성전자");
    expect(await resolveSymbol("삼전", KV)).toBe("005930.KS");
  });

  it("ignores list position when picking the canonical name", async () => {
    await KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "별칭", value: "X", alias: true }, { key: "정식", value: "X" }]));
    resetSymbolCache();
    expect(await symbolName("X", KV)).toBe("정식");
    await KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "별칭만", value: "Y", alias: true }]));
    resetSymbolCache();
    expect(await symbolName("Y", KV)).toBe("별칭만");
  });
});

describe("user aliases", () => {
  it("preserves concurrent additions and mixed additions/removals", async () => {
    stub(() => ({ quotes: [] }));
    await Promise.all([
      addAlias(KV, "별칭A", "삼성전자", WRITER),
      addAlias(KV, "별칭B", "SK하이닉스", WRITER),
    ]);
    expect(await listAliases(KV)).toEqual(expect.arrayContaining([
      { key: "별칭A", value: "005930.KS" },
      { key: "별칭B", value: "000660.KS" },
    ]));
    await Promise.all([
      removeAlias("별칭A", WRITER),
      addAlias(KV, "별칭C", "삼성전자", WRITER),
    ]);
    expect((await listAliases(KV)).map((entry) => entry.key).sort()).toEqual(["별칭B", "별칭C"]);
  });

  it("adds an alias by exact name, resolves it, and shows the canonical name", async () => {
    const fn = stub(() => ({ quotes: [] }));
    const r = await addAlias(KV, " 하닉 ", "SK하이닉스", WRITER);
    expect(r).toEqual({ alias: "하닉", symbol: "000660.KS", display: "SK하이닉스 (000660.KS)" });
    expect(await listAliases(KV)).toEqual([{ key: "하닉", value: "000660.KS" }]);
    expect(await resolveSymbol("하닉", KV)).toBe("000660.KS");
    expect(await searchSymbols("하닉", KV)).toEqual([{ name: "SK하이닉스 (000660.KS)", value: "000660.KS" }]);
    expect(await symbolName("000660.KS", KV)).toBe("SK하이닉스");
    expect(fn).not.toHaveBeenCalled();
  });

  it("accepts a partial name via search and a raw symbol via a quote lookup", async () => {
    const fn = stub((u) => (u.pathname.includes("/chart/PLTR") ? series : u.pathname.includes("/chart/") ? notFound : { quotes: [] }));
    expect((await addAlias(KV, "삼우", "삼성전자우", WRITER)).display).toBe("삼성전자우 (005935.KS)");
    expect(await addAlias(KV, "팔란티어", "PLTR", WRITER)).toEqual({ alias: "팔란티어", symbol: "PLTR", display: "Palantir Technologies (PLTR)" });
    expect(fn.mock.calls.some((c) => String(c[0]).includes("/chart/PLTR"))).toBe(true);
    await expect(addAlias(KV, "없음", "NOPE.XX", WRITER)).rejects.toThrow("찾지 못했습니다");
    await expect(addAlias(KV, "없음", "ZZZZ", WRITER)).rejects.toThrow("찾지 못했습니다");
    await expect(addAlias(KV, "없음", "존재하지않는회사", WRITER)).rejects.toThrow("찾지 못했습니다");
    expect(await symbolName("PLTR", KV)).toBe("팔란티어");
  });

  it("rejects symbol-shaped aliases and names already used by the seed list, but allows overwriting its own", async () => {
    stub(() => ({ quotes: [] }));
    await expect(addAlias(KV, "005930.KS", "삼성전자", WRITER)).rejects.toThrow("심볼 형식");
    await expect(addAlias(KV, "삼성전자", "SK하이닉스", WRITER)).rejects.toThrow("이미 종목명");
    await expect(addAlias(KV, "삼전", "SK하이닉스", WRITER)).rejects.toThrow("이미 종목명");
    await addAlias(KV, "하닉", "삼성전자", WRITER);
    await addAlias(KV, "하닉", "SK하이닉스", WRITER);
    expect(await listAliases(KV)).toEqual([{ key: "하닉", value: "000660.KS" }]);
    await expect(addAlias(KV, "", "삼성전자", WRITER)).rejects.toThrow("사용법");
  });

  it("removes aliases and reports missing ones", async () => {
    stub(() => ({ quotes: [] }));
    await addAlias(KV, "하닉", "SK하이닉스", WRITER);
    expect(await removeAlias("하닉", WRITER)).toEqual({ key: "하닉", value: "000660.KS" });
    expect(await listAliases(KV)).toEqual([]);
    expect(await resolveSymbol("하닉", KV)).toBe("하닉");
    await expect(removeAlias("하닉", WRITER)).rejects.toThrow("별칭이 없습니다");
  });

  it("runAlias formats add/remove/list and autocompletes aliases", async () => {
    stub(() => ({ quotes: [] }));
    expect(await runAlias({ action: "list" }, { KV, ALIAS_WRITER: WRITER })).toBe("등록된 별칭이 없습니다.");
    expect(await runAlias({ action: "add", alias: "하닉", target: "SK하이닉스" }, { KV, ALIAS_WRITER: WRITER })).toBe("✅ 별칭 추가: 하닉 → SK하이닉스 (000660.KS)");
    expect(await runAlias({ action: "list" }, { KV, ALIAS_WRITER: WRITER })).toBe("• 하닉 → SK하이닉스 (000660.KS)");
    expect(await searchAliases("하", KV)).toEqual([{ name: "하닉 → SK하이닉스 (000660.KS)", value: "하닉" }]);
    expect(await searchAliases("zz", KV)).toEqual([]);
    expect(await runAlias({ action: "remove", alias: "하닉" }, { KV, ALIAS_WRITER: WRITER })).toBe("🗑️ 별칭 삭제: 하닉 → 000660.KS");
    await expect(runAlias({ action: "bogus" }, { KV, ALIAS_WRITER: WRITER })).rejects.toThrow("사용법");
  });
});
