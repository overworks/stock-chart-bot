import { afterEach, describe, expect, it, vi } from "vitest";
import { configureKis, createKis, kis } from "../src/core/providers/kis";
import { yahoo } from "../src/core/providers/yahoo";
import { getPrices, SymbolNotFoundError } from "../src/core/market";

const NOW = Date.parse("2026-09-04T01:00:00Z"); // 10:00 KST

function memoryKv() {
  const store = new Map<string, string>();
  const puts: string[] = [];
  const kv = {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => {
      puts.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

function provider(kv?: KVNamespace, now = NOW) {
  return createKis(() => ({ appKey: "key", appSecret: "secret", kv }), () => now);
}

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown };

function stub(handler: Handler) {
  const calls: { url: URL; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      if (url.pathname === "/oauth2/tokenP") return Response.json({ access_token: "tok", expires_in: 86_400 });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calls;
}

function day(date: string, close: number) {
  return { stck_bsop_date: date, stck_clpr: String(close), stck_oprc: String(close - 1), stck_hgpr: String(close + 1), stck_lwpr: String(close - 2), acml_vol: "10" };
}

function minute(date: string, hour: string, price: number) {
  return { stck_bsop_date: date, stck_cntg_hour: hour, stck_prpr: String(price), stck_oprc: String(price), stck_hgpr: String(price + 1), stck_lwpr: String(price - 1), cntg_vol: "1" };
}

const ok = (output2: unknown[], name = "삼성전자") => ({ rt_cd: "0", msg_cd: "MCA00000", msg1: "정상처리", output1: { hts_kor_isnm: name }, output2 });

afterEach(() => vi.unstubAllGlobals());

describe("kis provider", () => {
  it("only claims KRX symbols when credentials are configured", () => {
    const p = provider();
    expect(p.supports!("005930.KS")).toBe(true);
    expect(p.supports!("0167A0.KQ")).toBe(true);
    expect(p.supports!("AAPL")).toBe(false);
    expect(p.supports!("KRW-BTC")).toBe(false);
    expect(createKis(() => undefined).supports!("005930.KS")).toBe(false);
  });

  it("maps daily rows into ascending KST bars and sends auth headers", async () => {
    const calls = stub(() => ({ body: ok([day("20260904", 105), day("20260903", 100)]) }));
    const s = await provider().getPrices("005930.KS", { ticker: "x", range: "1m" });
    const chart = calls[1];
    expect(chart.url.pathname).toBe("/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice");
    expect(chart.url.searchParams.get("FID_INPUT_ISCD")).toBe("005930");
    expect(chart.url.searchParams.get("FID_PERIOD_DIV_CODE")).toBe("D");
    expect(chart.url.searchParams.get("FID_INPUT_DATE_1")).toBe("20260804");
    expect(chart.url.searchParams.get("FID_INPUT_DATE_2")).toBe("20260904");
    const headers = chart.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers.tr_id).toBe("FHKST03010100");
    expect(s.bars).toEqual([
      { t: Date.parse("2026-09-03") / 1000, c: 100, o: 99, h: 101, l: 98, v: 10 },
      { t: Date.parse("2026-09-04") / 1000, c: 105, o: 104, h: 106, l: 103, v: 10 },
    ]);
    expect(s).toMatchObject({ label: "1m", intraday: false, timeZone: "Asia/Seoul", currency: "KRW", source: "한국투자증권", name: "삼성전자" });
  });

  it("issues the token once and caches it in memory and KV", async () => {
    const { kv, puts } = memoryKv();
    const calls = stub(() => ({ body: ok([day("20260904", 105), day("20260903", 100)]) }));
    const p = provider(kv);
    await p.getPrices("005930.KS", { ticker: "x", range: "1m" });
    await p.getPrices("005930.KS", { ticker: "x", range: "3m" });
    expect(calls.filter((c) => c.url.pathname === "/oauth2/tokenP")).toHaveLength(1);
    expect(puts).toEqual(["kis:token:v1"]);

    const again = stub(() => ({ body: ok([day("20260904", 105), day("20260903", 100)]) }));
    await provider(kv).getPrices("005930.KS", { ticker: "x", range: "1m" });
    expect(again.filter((c) => c.url.pathname === "/oauth2/tokenP")).toHaveLength(0);
  });

  it("pages daily rows backwards until the start date", async () => {
    const first = Array.from({ length: 100 }, (_, i) => day(String(20260904 - i), 100));
    const calls = stub((url) => ({
      body: ok(url.searchParams.get("FID_INPUT_DATE_2") === "20260904" ? first : [day("20260801", 90)]),
    }));
    const s = await provider().getPrices("005930.KS", { ticker: "x", from: "2026-08-01", to: "2026-09-04" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("itemchartprice"));
    expect(pages).toHaveLength(2);
    expect(pages[1].url.searchParams.get("FID_INPUT_DATE_2")).toBe(String(20260904 - 100));
    expect(s.bars[0].c).toBe(90);
    expect(s.label).toBe("2026-08-01 ~ 2026-09-04");
  });

  it("builds 1d from the latest session's minute bars bucketed to 5 minutes", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260904", 105), day("20260903", 100)]) };
      return { body: ok([minute("20260904", "090600", 104), minute("20260904", "090100", 102), minute("20260904", "090000", 101), minute("20260903", "153000", 100)]) };
    });
    const s = await provider().getPrices("005930.KS", { ticker: "x", range: "1d" });
    const page = calls.find((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"))!;
    expect(page.url.searchParams.get("FID_INPUT_DATE_1")).toBe("20260904");
    expect(page.url.searchParams.get("FID_INPUT_HOUR_1")).toBe("100000");
    expect(page.url.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("UN");
    const at = (hm: string) => Date.parse(`2026-09-04T${hm}:00+09:00`) / 1000;
    expect(s.bars).toEqual([
      { t: at("09:00"), c: 102, o: 101, h: 103, l: 100, v: 2 },
      { t: at("09:05"), c: 104, o: 104, h: 105, l: 103, v: 1 },
    ]);
    expect(s.intraday).toBe(true);
    expect(s.previousClose).toBe(100);
  });

  it("shows today's pre-market before the daily row exists", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260903", 100), day("20260902", 90)]) };
      const date = url.searchParams.get("FID_INPUT_DATE_1")!;
      return { body: ok([minute(date, "081000", 103), minute(date, "080000", 101)]) };
    });
    const s = await provider(undefined, Date.parse("2026-09-04T08:30:00+09:00")).getPrices("005930.KS", { ticker: "x", range: "1d" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages.map((c) => c.url.searchParams.get("FID_INPUT_DATE_1"))).toEqual(["20260904"]);
    expect(pages[0].url.searchParams.get("FID_INPUT_HOUR_1")).toBe("083000");
    expect(s.bars[0].t).toBe(Date.parse("2026-09-04T08:00:00+09:00") / 1000);
    expect(s.previousClose).toBe(100);
  });

  it("uses the last session through the after-market on weekends", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260904", 105), day("20260903", 100)]) };
      return { body: ok([minute("20260904", "195900", 106), minute("20260904", "160000", 105), minute("20260904", "090000", 101)]) };
    });
    const s = await provider(undefined, Date.parse("2026-09-06T12:00:00+09:00")).getPrices("005930.KS", { ticker: "x", range: "1d" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages).toHaveLength(1);
    expect(pages[0].url.searchParams.get("FID_INPUT_DATE_1")).toBe("20260904");
    expect(pages[0].url.searchParams.get("FID_INPUT_HOUR_1")).toBe("200000");
    expect(s.bars.at(-1)!.c).toBe(106);
    expect(s.previousClose).toBe(100);
  });

  it("falls back to the KRX session when UN has no regular-hours bars", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260904", 105), day("20260903", 100)]) };
      if (url.searchParams.get("FID_COND_MRKT_DIV_CODE") === "UN") return { body: ok([minute("20260904", "153000", 105)]) };
      return { body: ok([minute("20260904", "153000", 105), minute("20260904", "090000", 101)]) };
    });
    const s = await provider(undefined, Date.parse("2026-09-06T12:00:00+09:00")).getPrices("069500.KS", { ticker: "x", range: "1d" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages.map((c) => c.url.searchParams.get("FID_COND_MRKT_DIV_CODE"))).toEqual(["UN", "J"]);
    expect(pages[1].url.searchParams.get("FID_INPUT_HOUR_1")).toBe("153000");
    expect(s.bars).toHaveLength(2);
  });

  it("keeps 1w on the regular KRX session", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260903", 105), day("20260902", 100)]) };
      const date = url.searchParams.get("FID_INPUT_DATE_1")!;
      return { body: ok([minute(date, "100000", 104), minute(date, "090000", 101)]) };
    });
    await provider(undefined, Date.parse("2026-09-05T12:00:00+09:00")).getPrices("005930.KS", { ticker: "x", range: "1w" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages).toHaveLength(2);
    for (const p of pages) {
      expect(p.url.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("J");
      expect(p.url.searchParams.get("FID_INPUT_HOUR_1")).toBe("153000");
    }
  });

  it("reports API errors and unknown symbols", async () => {
    stub(() => ({ status: 500, body: { rt_cd: "1", msg_cd: "EGW00123", msg1: "기간이 만료된 token 입니다." } }));
    await expect(provider().getPrices("005930.KS", { ticker: "x", range: "1m" })).rejects.toThrow("만료된 token");
    stub(() => ({ body: { rt_cd: "0", output1: {}, output2: [] } }));
    await expect(provider().getPrices("999999.KS", { ticker: "x", range: "1m" })).rejects.toBeInstanceOf(SymbolNotFoundError);
  });

  it("falls back to Yahoo when KIS fails", async () => {
    stub((url) => {
      if (url.hostname === "openapi.koreainvestment.com") return { status: 500, body: { rt_cd: "1", msg1: "서버 오류" } };
      return { body: { chart: { result: [{ meta: { currency: "KRW" }, timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } } };
    });
    const s = await getPrices("005930.KS", { ticker: "x", range: "1m" }, [provider(), yahoo]);
    expect(s.source).toBe("Yahoo Finance");
  });
});

describe("configureKis", () => {
  afterEach(() => configureKis(undefined, undefined));

  it("enables the default provider only with both keys", () => {
    expect(kis.supports!("005930.KS")).toBe(false);
    configureKis("key", "");
    expect(kis.supports!("005930.KS")).toBe(false);
    configureKis("key", "secret");
    expect(kis.supports!("005930.KS")).toBe(true);
  });
});
