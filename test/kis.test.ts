import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviders } from "../src/providers";
import { createKis } from "../src/providers/kis";
import { yahoo } from "../src/providers/yahoo";
import { getPrices, SymbolNotFoundError } from "../src/core/market";
import { captureLogs } from "./logs";

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
  return createKis({ appKey: "key", appSecret: "secret", kv }, () => now);
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kis provider", () => {
  it("only claims KRX symbols", () => {
    const p = provider();
    expect(p.supports!("005930.KS")).toBe(true);
    expect(p.supports!("0167A0.KQ")).toBe(true);
    expect(p.supports!("AAPL")).toBe(false);
    expect(p.supports!("KRW-BTC")).toBe(false);
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
    const logs = captureLogs();
    const calls = stub(() => ({ body: ok([day("20260904", 105), day("20260903", 100)]) }));
    const p = provider(kv);
    await p.getPrices("005930.KS", { ticker: "x", range: "1m" });
    await p.getPrices("005930.KS", { ticker: "x", range: "3m" });
    expect(calls.filter((c) => c.url.pathname === "/oauth2/tokenP")).toHaveLength(1);
    expect(puts).toEqual(["kis:token:v1"]);

    const again = stub(() => ({ body: ok([day("20260904", 105), day("20260903", 100)]) }));
    await provider(kv).getPrices("005930.KS", { ticker: "x", range: "1m" });
    expect(again.filter((c) => c.url.pathname === "/oauth2/tokenP")).toHaveLength(0);
    expect(logs("chart.kis.token.issued")).toEqual([{ level: "log", message: "chart.kis.token.issued", "chart.kis.token.ttl": 86_400 }]);
    expect(JSON.stringify(logs("chart.kis.token.issued"))).not.toContain("tok\"");
  });

  it("logs token cache failures and rate-limit retries", async () => {
    const logs = captureLogs();
    const kv = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV down"); } } as unknown as KVNamespace;
    let limited = true;
    stub(() => {
      if (!limited) return { body: ok([day("20260904", 105), day("20260903", 100)]) };
      limited = false;
      return { status: 500, body: { rt_cd: "1", msg_cd: "EGW00201", msg1: "초당 거래건수를 초과하였습니다." } };
    });
    const s = await provider(kv).getPrices("005930.KS", { ticker: "x", range: "1m" });
    expect(s.bars).toHaveLength(2);
    expect(logs("chart.kis.token.cache_failed").map((e) => [e.level, e["chart.kis.token.cache_operation"], e["exception.message"]])).toEqual([
      ["warn", "get", "KV down"],
      ["warn", "put", "KV down"],
    ]);
    expect(logs("chart.kis.rate_limited")).toEqual([{ level: "warn", message: "chart.kis.rate_limited", "chart.kis.tr_id": "FHKST03010100", "chart.kis.attempt": 0 }]);
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
    expect(s.regularHours).toEqual([{ start: at("09:00"), end: at("15:30") }]);
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
    const logs = captureLogs();
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
    expect(logs("chart.market.fallback")).toEqual([expect.objectContaining({ level: "log", "chart.provider.name": "kis", "chart.kis.code": "069500", "chart.session.date": "20260904" })]);
  });

  it.each([
    ["one current bar mixed with old history", ["100000"]],
    ["current bars in a single five-minute bucket", ["100100", "100000"]],
  ])("retries KRX before Yahoo when UN has %s", async (_label, hours) => {
    const calls = stub((url) => {
      if (url.hostname === "query1.finance.yahoo.com") {
        return { body: { chart: { result: [{ timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } } };
      }
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260904", 105), day("20260903", 100)], "LG씨엔에스") };
      if (url.searchParams.get("FID_COND_MRKT_DIV_CODE") === "UN") {
        const current = hours.map((hour) => minute("20260904", hour, 105));
        const old = Array.from({ length: 120 - current.length }, () => minute("20260630", "195900", 90));
        return { body: ok([...current, ...old], "LG씨엔에스") };
      }
      return { body: ok([minute("20260904", "100000", 105), minute("20260904", "090000", 101)], "LG씨엔에스") };
    });
    const s = await getPrices("064400.KS", { ticker: "LG씨엔에스", range: "1d" }, [provider(undefined, Date.parse("2026-09-04T10:01:00+09:00")), yahoo]);
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages.map((c) => c.url.searchParams.get("FID_COND_MRKT_DIV_CODE"))).toEqual(["UN", "J"]);
    expect(calls.some((c) => c.url.hostname.endsWith("finance.yahoo.com"))).toBe(false);
    expect(s.source).toBe("한국투자증권");
    expect(s.bars.map((b) => b.c)).toEqual([101, 105]);
    expect(s.previousClose).toBe(100);
  });

  it("uses the previous session when today's row exists but has a single 5-minute bucket", async () => {
    const logs = captureLogs();
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260904", 101), day("20260903", 100), day("20260902", 90)]) };
      const date = url.searchParams.get("FID_INPUT_DATE_1")!;
      if (date === "20260904") return { body: ok([minute(date, "090100", 102), minute(date, "090000", 101)]) };
      return { body: ok([minute(date, "153000", 100), minute(date, "090000", 95)]) };
    });
    const s = await provider(undefined, Date.parse("2026-09-04T09:02:00+09:00")).getPrices("005930.KS", { ticker: "x", range: "1d" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("inquire-time-dailychartprice"));
    expect(pages.map((c) => [c.url.searchParams.get("FID_INPUT_DATE_1"), c.url.searchParams.get("FID_COND_MRKT_DIV_CODE")])).toEqual([
      ["20260904", "UN"],
      ["20260904", "J"],
      ["20260903", "UN"],
    ]);
    const at = (hm: string) => Date.parse(`2026-09-03T${hm}:00+09:00`) / 1000;
    expect(s.bars.map((b) => [b.t, b.c])).toEqual([
      [at("09:00"), 95],
      [at("15:30"), 100],
    ]);
    expect(s.previousClose).toBe(90);
    expect(s.regularHours).toEqual([{ start: at("09:00"), end: at("15:30") }]);
    expect(logs("chart.session.fallback")).toEqual([{ level: "log", message: "chart.session.fallback", "chart.provider.name": "kis", "chart.symbol": "005930.KS", "chart.bars": 1, "chart.session.date": "20260903", "chart.session.ok": true }]);
  });

  it("uses the last session when today's pre-market has a single bar", async () => {
    const logs = captureLogs();
    stub((url) => {
      if (url.pathname.endsWith("inquire-daily-itemchartprice")) return { body: ok([day("20260903", 100), day("20260902", 90)]) };
      const date = url.searchParams.get("FID_INPUT_DATE_1")!;
      if (date === "20260904") return { body: ok(url.searchParams.get("FID_COND_MRKT_DIV_CODE") === "UN" ? [minute(date, "080100", 101)] : []) };
      return { body: ok([minute(date, "153000", 100), minute(date, "090000", 95)]) };
    });
    const s = await provider(undefined, Date.parse("2026-09-04T08:03:00+09:00")).getPrices("005930.KS", { ticker: "x", range: "1d" });
    expect(s.bars.map((b) => b.c)).toEqual([95, 100]);
    expect(s.bars[0].t).toBe(Date.parse("2026-09-03T09:00:00+09:00") / 1000);
    expect(s.previousClose).toBe(90);
    expect(logs("chart.session.fallback")[0]).toMatchObject({ level: "log", "chart.session.date": "20260903", "chart.session.ok": true });
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

function indexDay(date: string, close: number) {
  return { stck_bsop_date: date, bstp_nmix_prpr: String(close), bstp_nmix_oprc: String(close - 1), bstp_nmix_hgpr: String(close + 1), bstp_nmix_lwpr: String(close - 2), acml_vol: "10" };
}

function indexMinute(date: string, hour: string, price: number) {
  return { stck_bsop_date: date, stck_cntg_hour: hour, bstp_nmix_prpr: String(price), bstp_nmix_oprc: String(price), bstp_nmix_hgpr: String(price + 1), bstp_nmix_lwpr: String(price - 1), cntg_vol: "1" };
}

describe("kis domestic indices", () => {
  const kst = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+09:00`) / 1000;

  it("claims KOSPI, KOSDAQ and KOSPI200 only", () => {
    const p = provider();
    for (const s of ["^KS11", "^KQ11", "^KS200"]) expect(p.supports!(s)).toBe(true);
    expect(p.supports!("^GSPC")).toBe(false);
    expect(p.supports!("constructor")).toBe(false);
  });

  it("maps index daily rows from the sector API", async () => {
    const calls = stub(() => ({ body: ok([indexDay("20260904", 3105.5), indexDay("20260903", 3100)], "종합") }));
    const s = await provider().getPrices("^KS11", { ticker: "x", range: "1m" });
    const chart = calls[1];
    expect(chart.url.pathname).toBe("/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice");
    expect((chart.init.headers as Record<string, string>).tr_id).toBe("FHKUP03500100");
    expect(chart.url.searchParams.get("FID_COND_MRKT_DIV_CODE")).toBe("U");
    expect(chart.url.searchParams.get("FID_INPUT_ISCD")).toBe("0001");
    expect(chart.url.searchParams.has("FID_ORG_ADJ_PRC")).toBe(false);
    expect(s.bars).toEqual([
      { t: Date.parse("2026-09-03") / 1000, c: 3100, o: 3099, h: 3101, l: 3098, v: 10 },
      { t: Date.parse("2026-09-04") / 1000, c: 3105.5, o: 3104.5, h: 3106.5, l: 3103.5, v: 10 },
    ]);
    expect(s).toMatchObject({ intraday: false, timeZone: "Asia/Seoul", currency: "KRW", source: "한국투자증권", name: "종합" });
  });

  it("pages index daily rows 50 at a time", async () => {
    const ymd = (i: number) => new Date(Date.parse("2026-09-04") - i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
    const first = Array.from({ length: 50 }, (_, i) => indexDay(ymd(i), 100));
    const calls = stub((url) => ({
      body: ok(url.searchParams.get("FID_INPUT_DATE_2") === "20260904" ? first : [indexDay("20260701", 90)]),
    }));
    const s = await provider().getPrices("^KQ11", { ticker: "x", from: "2026-07-01", to: "2026-09-04" });
    const pages = calls.filter((c) => c.url.pathname.endsWith("indexchartprice"));
    expect(pages).toHaveLength(2);
    expect(pages[0].url.searchParams.get("FID_INPUT_ISCD")).toBe("1001");
    expect(pages[1].url.searchParams.get("FID_INPUT_DATE_2")).toBe(ymd(50));
    expect(s.bars[0].c).toBe(90);
  });

  it("builds 1d from the latest session's 5-minute index bars", async () => {
    const calls = stub((url) => {
      if (url.pathname.endsWith("inquire-daily-indexchartprice")) return { body: ok([indexDay("20260904", 105), indexDay("20260903", 100)]) };
      return {
        body: ok([indexMinute("20260904", "090500", 104), indexMinute("20260904", "090000", 102), indexMinute("20260903", "999999", 1), indexMinute("20260903", "153000", 100)], "종합"),
      };
    });
    const s = await provider().getPrices("^KS200", { ticker: "x", range: "1d" });
    const minute = calls.find((c) => c.url.pathname.endsWith("inquire-time-indexchartprice"))!;
    expect((minute.init.headers as Record<string, string>).tr_id).toBe("FHKUP03500200");
    expect(Object.fromEntries(minute.url.searchParams)).toEqual({
      FID_COND_MRKT_DIV_CODE: "U",
      FID_ETC_CLS_CODE: "1",
      FID_INPUT_ISCD: "2001",
      FID_INPUT_HOUR_1: "300",
      FID_PW_DATA_INCU_YN: "Y",
    });
    expect(s.bars).toEqual([
      { t: kst("2026-09-04", "09:00"), c: 102, o: 102, h: 103, l: 101, v: 1 },
      { t: kst("2026-09-04", "09:05"), c: 104, o: 104, h: 105, l: 103, v: 1 },
    ]);
    expect(s).toMatchObject({ intraday: true, previousClose: 100, name: "종합" });
    expect(s.regularHours).toBeUndefined();
  });

  it("builds 1w from the last five sessions of 30-minute index bars", async () => {
    const dates = ["20260828", "20260831", "20260901", "20260902", "20260903", "20260904"];
    const calls = stub(() => ({ body: ok(dates.flatMap((d, i) => [indexMinute(d, "100000", 100 + i), indexMinute(d, "090000", 100 + i)]).reverse()) }));
    const s = await provider(undefined, Date.parse("2026-09-05T12:00:00+09:00")).getPrices("^KS11", { ticker: "x", range: "1w" });
    expect(calls.filter((c) => c.url.pathname.endsWith("inquire-daily-indexchartprice"))).toHaveLength(0);
    expect(calls.find((c) => c.url.pathname.endsWith("inquire-time-indexchartprice"))!.url.searchParams.get("FID_INPUT_HOUR_1")).toBe("1800");
    expect(s.bars).toHaveLength(10);
    expect(s.bars[0].t).toBe(kst("2026-08-31", "09:00"));
    expect(s.bars.at(-1)!.t).toBe(kst("2026-09-04", "10:00"));
  });

  it("uses the previous index session right after the open", async () => {
    const logs = captureLogs();
    stub((url) => {
      if (url.pathname.endsWith("inquire-daily-indexchartprice")) return { body: ok([indexDay("20260904", 106), indexDay("20260903", 100), indexDay("20260902", 90)]) };
      return { body: ok([indexMinute("20260904", "090000", 106), indexMinute("20260903", "153000", 100), indexMinute("20260903", "090500", 97), indexMinute("20260903", "090000", 95)], "종합") };
    });
    const s = await provider(undefined, Date.parse("2026-09-04T09:02:00+09:00")).getPrices("^KS11", { ticker: "x", range: "1d" });
    expect(s.bars.map((b) => [b.t, b.c])).toEqual([
      [kst("2026-09-03", "09:00"), 95],
      [kst("2026-09-03", "09:05"), 97],
      [kst("2026-09-03", "15:30"), 100],
    ]);
    expect(s.previousClose).toBe(90);
    expect(logs("chart.session.fallback")).toEqual([{ level: "log", message: "chart.session.fallback", "chart.provider.name": "kis", "chart.symbol": "^KS11", "chart.bars": 1, "chart.session.date": "20260903", "chart.session.ok": true }]);
  });

  it("falls back to Yahoo when KIS has too few sessions or fails", async () => {
    const yahooBody = { chart: { result: [{ meta: { currency: "KRW" }, timestamp: [1, 2], indicators: { quote: [{ close: [1, 2] }] } }] } };
    stub((url) => {
      if (url.hostname === "openapi.koreainvestment.com") return { body: ok([indexMinute("20260904", "100000", 101), indexMinute("20260904", "090000", 100)]) };
      return { body: yahooBody };
    });
    expect((await getPrices("^KS11", { ticker: "x", range: "1w" }, [provider(), yahoo])).source).toBe("Yahoo Finance");

    stub((url) => {
      if (url.hostname === "openapi.koreainvestment.com") return { status: 500, body: { rt_cd: "1", msg1: "서버 오류" } };
      return { body: yahooBody };
    });
    expect((await getPrices("^KQ11", { ticker: "x", range: "1m" }, [provider(), yahoo])).source).toBe("Yahoo Finance");
  });
});

describe("createProviders", () => {
  const names = (cfg?: Parameters<typeof createProviders>[0]) => createProviders(cfg).map((p) => p.name);

  it("includes KIS only with both keys, between Upbit and Yahoo", () => {
    expect(names()).toEqual(["Upbit", "Yahoo Finance"]);
    expect(names({ kisAppKey: "key", kisAppSecret: "" })).toEqual(["Upbit", "Yahoo Finance"]);
    expect(names({ kisAppKey: "key", kisAppSecret: "secret" })).toEqual(["Upbit", "한국투자증권", "Yahoo Finance"]);
  });
});
