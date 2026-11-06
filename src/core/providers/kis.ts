import type { ChartBar, ChartRequest, TimeSpan } from "../types";
import { SymbolNotFoundError, type MarketProvider, type PriceSeries } from "./types";

const API = "https://openapi.koreainvestment.com:9443";
const MINUTE = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice";
const INDEX_MINUTE = "/uapi/domestic-stock/v1/quotations/inquire-time-indexchartprice";
const SYMBOL = /^([0-9A-Z]{6})\.(KS|KQ)$/;
/** Yahoo 지수 심볼 → 한국투자증권 업종코드 */
const INDEX = new Map([
  ["^KS11", "0001"],
  ["^KQ11", "1001"],
  ["^KS200", "2001"],
]);
const TOKEN_KEY = "kis:token:v1";
const TOKEN_MARGIN = 3600;
const MINUTE_PAGE = 120;
const MAX_DAILY_PAGES = 20;
const MAX_MINUTE_PAGES = 7;
const RATE_LIMITED = "EGW00201";
const KST = 9 * 3600;

interface Session {
  market: string;
  open: string;
  close: string;
}

const REGULAR: Session = { market: "J", open: "090000", close: "153000" };
/** KRX+NXT 통합. NXT 프리마켓(08:00~)부터 애프터마켓(~20:00)까지. */
const EXTENDED: Session = { market: "UN", open: "080000", close: "200000" };

export interface KisConfig {
  appKey: string;
  appSecret: string;
  kv?: KVNamespace;
}

interface Token {
  token: string;
  expiresAt: number;
}

interface Row {
  [key: string]: string | undefined;
}

interface Body {
  rt_cd?: string;
  msg_cd?: string;
  msg1?: string;
  output1?: Row;
  output2?: Row[];
}

interface Fields {
  c: string;
  o: string;
  h: string;
  l: string;
  v: string;
}

interface DailyApi {
  path: string;
  trId: string;
  params: Record<string, string>;
  page: number;
  fields: Fields;
}

const STOCK_DAILY: DailyApi = {
  path: "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
  trId: "FHKST03010100",
  params: { FID_COND_MRKT_DIV_CODE: "J", FID_ORG_ADJ_PRC: "0" },
  page: 100,
  fields: { c: "stck_clpr", o: "stck_oprc", h: "stck_hgpr", l: "stck_lwpr", v: "acml_vol" },
};

const INDEX_DAILY: DailyApi = {
  path: "/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice",
  trId: "FHKUP03500100",
  params: { FID_COND_MRKT_DIV_CODE: "U" },
  page: 50,
  fields: { c: "bstp_nmix_prpr", o: "bstp_nmix_oprc", h: "bstp_nmix_hgpr", l: "bstp_nmix_lwpr", v: "acml_vol" },
};

const STOCK_MINUTE_FIELDS: Fields = { ...STOCK_DAILY.fields, c: "stck_prpr", v: "cntg_vol" };
const INDEX_MINUTE_FIELDS: Fields = { ...INDEX_DAILY.fields, v: "cntg_vol" };

const RANGE: Record<string, { period: "D" | "W" | "M"; days: number } | { minutes: number; sessions: number }> = {
  "1d": { minutes: 5, sessions: 1 },
  "1w": { minutes: 30, sessions: 5 },
  "1m": { period: "D", days: 31 },
  "3m": { period: "D", days: 92 },
  "6m": { period: "D", days: 183 },
  "1y": { period: "D", days: 366 },
  "5y": { period: "W", days: 5 * 366 },
  max: { period: "M", days: 0 },
};

/** 한국투자증권 Open API. KRX 종목(.KS/.KQ)과 국내 지수(^KS11 등)를 맡고 앱키가 없으면 건너뛴다. */
export function createKis(config: () => KisConfig | undefined, now: () => number = Date.now): MarketProvider {
  let cached: Token | undefined;
  let pending: Promise<Token> | undefined;

  async function token(cfg: KisConfig): Promise<string> {
    const nowSec = Math.floor(now() / 1000);
    if (cached && cached.expiresAt - TOKEN_MARGIN > nowSec) return cached.token;
    pending ??= loadToken(cfg, nowSec).finally(() => (pending = undefined));
    cached = await pending;
    return cached.token;
  }

  async function call(cfg: KisConfig, path: string, trId: string, params: Record<string, string>): Promise<Body> {
    const url = `${API}${path}?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${await token(cfg)}`,
          appkey: cfg.appKey,
          appsecret: cfg.appSecret,
          tr_id: trId,
          custtype: "P",
        },
      });
      let body: Body;
      try {
        body = await res.json();
      } catch {
        throw new Error(`시세 조회 실패 (${res.status})`);
      }
      if (body.msg_cd === RATE_LIMITED && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (body.msg_cd === RATE_LIMITED) throw new Error("한국투자증권 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.");
      if (!res.ok || body.rt_cd !== "0") throw new Error(`한국투자증권 시세 조회 실패 (${body.msg1?.trim() || res.status})`);
      return body;
    }
  }

  async function daily(cfg: KisConfig, api: DailyApi, code: string, period: "D" | "W" | "M", from: string, to: string) {
    const rows: Row[] = [];
    let name: string | undefined;
    let end = to;
    for (let page = 0; ; page++) {
      if (page === MAX_DAILY_PAGES) throw new Error("한국투자증권 조회 기간이 너무 깁니다.");
      const body = await call(cfg, api.path, api.trId, {
        ...api.params,
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: end,
        FID_PERIOD_DIV_CODE: period,
      });
      name ??= body.output1?.hts_kor_isnm?.trim() || undefined;
      const got = (body.output2 ?? []).filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? ""));
      rows.push(...got);
      const last = got.at(-1)?.stck_bsop_date;
      if (got.length < api.page || !last || last <= from) break;
      end = ymd(dateSec(last) - 86_400);
    }
    if (!rows.length && !name) throw new SymbolNotFoundError(`'${code}' 시세를 한국투자증권에서 찾지 못했습니다.`);
    const bars = dedupe(rows.map((r) => toBar(r, dateSec(r.stck_bsop_date!), api.fields)));
    return { bars, name };
  }

  // 업종 분봉은 날짜를 지정할 수 없고 최근 102개 봉만 온다. 5분봉이면 1세션, 30분봉이면 7세션쯤 된다.
  async function indexIntraday(cfg: KisConfig, symbol: string, code: string, plan: { minutes: number; sessions: number }, today: string) {
    const [body, recent] = await Promise.all([
      call(cfg, INDEX_MINUTE, "FHKUP03500200", {
        FID_COND_MRKT_DIV_CODE: "U",
        FID_ETC_CLS_CODE: "1",
        FID_INPUT_ISCD: code,
        FID_INPUT_HOUR_1: String(plan.minutes * 60),
        FID_PW_DATA_INCU_YN: "Y",
      }),
      plan.sessions === 1 ? daily(cfg, INDEX_DAILY, code, "D", ymd(Math.floor(now() / 1000) - 21 * 86_400), today) : undefined,
    ]);
    const rows = (body.output2 ?? []).filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? "") && /^([01]\d|2[0-3])\d{4}$/.test(r.stck_cntg_hour ?? ""));
    const dates = [...new Set(rows.map((r) => r.stck_bsop_date!))].sort().slice(-plan.sessions);
    if (dates.length < plan.sessions) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
    const bars = dedupe(
      rows.filter((r) => dates.includes(r.stck_bsop_date!)).map((r) => toBar(r, dateSec(r.stck_bsop_date!) + clockSec(r.stck_cntg_hour!), INDEX_MINUTE_FIELDS)),
    );
    const previousClose = recent?.bars.filter((b) => b.t < dateSec(dates[0])).at(-1)?.c;
    return { bars, previousClose, name: body.output1?.hts_kor_isnm?.trim() || recent?.name };
  }

  async function minutes(cfg: KisConfig, code: string, date: string, session: Session): Promise<ChartBar[]> {
    const today = ymd(Math.floor(now() / 1000)) === date;
    let hour = today ? hms(Math.floor(now() / 1000)) : session.close;
    if (hour > session.close) hour = session.close;
    const rows: Row[] = [];
    for (let page = 0; page < MAX_MINUTE_PAGES; page++) {
      const body = await call(cfg, MINUTE, "FHKST03010230", {
        FID_COND_MRKT_DIV_CODE: session.market,
        FID_INPUT_ISCD: code,
        FID_INPUT_HOUR_1: hour,
        FID_INPUT_DATE_1: date,
        FID_PW_DATA_INCU_YN: "Y",
        FID_FAKE_TICK_INCU_YN: "",
      });
      const all = body.output2 ?? [];
      const got = all.filter((r) => r.stck_bsop_date === date && /^\d{6}$/.test(r.stck_cntg_hour ?? ""));
      rows.push(...got);
      const earliest = got.map((r) => r.stck_cntg_hour!).sort()[0];
      if (all.length < MINUTE_PAGE || got.length < all.length || !earliest || earliest <= session.open) break;
      hour = earliest;
    }
    return dedupe(rows.map((r) => toBar(r, dateSec(date) + clockSec(r.stck_cntg_hour!), STOCK_MINUTE_FIELDS)));
  }

  // UN에 당일 봉이 부족하거나 장중 봉이 없으면 KRX 시세로 재조회한다.
  async function extended(cfg: KisConfig, code: string, date: string, size: number): Promise<ChartBar[]> {
    const bars = await minutes(cfg, code, date, EXTENDED);
    if (bucket(bars, size).length >= 2 && bars.some((b) => hms(b.t) < "150000")) return bars;
    return minutes(cfg, code, date, REGULAR);
  }

  const provider: MarketProvider = {
    name: "한국투자증권",

    supports(symbol) {
      return (SYMBOL.test(symbol) || INDEX.has(symbol)) && config() !== undefined;
    },

    async getPrices(symbol, req: ChartRequest) {
      const cfg = config();
      const index = INDEX.get(symbol);
      const code = index ?? SYMBOL.exec(symbol)?.[1];
      if (!cfg || !code) throw new Error("한국투자증권 설정이 없습니다.");
      const api = index ? INDEX_DAILY : STOCK_DAILY;
      const today = ymd(Math.floor(now() / 1000));

      let bars: ChartBar[];
      let name: string | undefined;
      let previousClose: number | undefined;
      let regularHours: TimeSpan[] | undefined;
      let label: string;
      let intraday = false;

      if (req.from && req.to) {
        label = `${req.from} ~ ${req.to}`;
        ({ bars, name } = await daily(cfg, api, code, "D", req.from.replaceAll("-", ""), req.to.replaceAll("-", "")));
      } else {
        label = req.range ?? "1d";
        const plan = RANGE[label] ?? RANGE["1d"];
        if ("period" in plan) {
          const from = plan.period === "M" ? "19800101" : ymd(Math.floor(now() / 1000) - plan.days * 86_400);
          ({ bars, name } = await daily(cfg, api, code, plan.period, from, today));
        } else if (index) {
          intraday = true;
          ({ bars, name, previousClose } = await indexIntraday(cfg, symbol, code, plan, today));
        } else {
          intraday = true;
          const recent = await daily(cfg, STOCK_DAILY, code, "D", ymd(Math.floor(now() / 1000) - 21 * 86_400), today);
          name = recent.name;
          const last = recent.bars.at(-1);
          if (!last) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
          if (plan.sessions === 1) {
            // 장 시작 전 프리마켓이면 일봉에 오늘이 아직 없을 수 있다.
            let date = ymd(last.t);
            let raw: ChartBar[] = [];
            if (date < today && tradingHours(Math.floor(now() / 1000))) raw = await extended(cfg, code, today, plan.minutes * 60);
            if (raw.length) date = today;
            else raw = await extended(cfg, code, date, plan.minutes * 60);
            previousClose = recent.bars.filter((b) => b.t < dateSec(date)).at(-1)?.c;
            regularHours = [{ start: dateSec(date) + clockSec(REGULAR.open), end: dateSec(date) + clockSec(REGULAR.close) }];
            bars = bucket(raw, plan.minutes * 60);
          } else {
            bars = [];
            for (const d of recent.bars.slice(-plan.sessions)) bars.push(...bucket(await minutes(cfg, code, ymd(d.t), REGULAR), plan.minutes * 60));
          }
        }
      }
      if (bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
      return { bars, label, intraday, timeZone: "Asia/Seoul", currency: "KRW", source: provider.name, name, previousClose, regularHours } satisfies PriceSeries;
    },

    // 종목 검색은 KV 목록과 Yahoo가 맡는다.
    async search() {
      return [];
    },
  };
  return provider;

  async function loadToken(cfg: KisConfig, nowSec: number): Promise<Token> {
    const stored = await cfg.kv?.get<Token>(TOKEN_KEY, "json").catch(() => null);
    if (stored && stored.expiresAt - TOKEN_MARGIN > nowSec) return stored;
    const res = await fetch(`${API}/oauth2/tokenP`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ grant_type: "client_credentials", appkey: cfg.appKey, appsecret: cfg.appSecret }),
    });
    const json: any = await res.json().catch(() => undefined);
    const access = json?.access_token;
    const ttl = Number(json?.expires_in);
    if (!res.ok || typeof access !== "string" || !(ttl > 0)) {
      throw new Error(`한국투자증권 인증 실패 (${json?.error_description ?? json?.msg1 ?? res.status})`);
    }
    const fresh = { token: access, expiresAt: nowSec + ttl };
    await cfg.kv?.put(TOKEN_KEY, JSON.stringify(fresh), { expirationTtl: Math.max(60, ttl - TOKEN_MARGIN) }).catch(() => undefined);
    return fresh;
  }
}

let current: KisConfig | undefined;

/** 요청 진입점에서 env로 한 번 호출한다. 키가 비어 있으면 KIS를 끈다. */
export function configureKis(appKey: string | undefined, appSecret: string | undefined, kv?: KVNamespace): void {
  current = appKey && appSecret ? { appKey, appSecret, kv } : undefined;
}

export const kis = createKis(() => current);

function toBar(r: Row, t: number, f: Fields): ChartBar | undefined {
  const c = num(r[f.c]);
  if (c === undefined || c === 0) return undefined;
  return { t, c, o: num(r[f.o]), h: num(r[f.h]), l: num(r[f.l]), v: num(r[f.v]) };
}

function dedupe(bars: (ChartBar | undefined)[]): ChartBar[] {
  const byTime = new Map<number, ChartBar>();
  for (const b of bars) if (b && !byTime.has(b.t)) byTime.set(b.t, b);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function bucket(bars: ChartBar[], size: number): ChartBar[] {
  const out: ChartBar[] = [];
  for (const b of bars) {
    const t = b.t - (b.t % size);
    const last = out.at(-1);
    if (last?.t !== t) {
      out.push({ ...b, t });
      continue;
    }
    last.c = b.c;
    if (b.h !== undefined) last.h = Math.max(last.h ?? b.h, b.h);
    if (b.l !== undefined) last.l = Math.min(last.l ?? b.l, b.l);
    if (b.v !== undefined) last.v = (last.v ?? 0) + b.v;
  }
  return out;
}

function num(x: string | undefined): number | undefined {
  const n = x === undefined || x.trim() === "" ? NaN : Number(x);
  return Number.isFinite(n) ? n : undefined;
}

/** "20260904" → 그날 09:00 KST(= 00:00 UTC)의 epoch 초. 일봉 시각으로 쓴다. */
function dateSec(d: string): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 1000;
}

/** "093000" → 그날 00:00 UTC 기준 KST 시각의 오프셋(초). */
function clockSec(h: string): number {
  return +h.slice(0, 2) * 3600 + +h.slice(2, 4) * 60 + +h.slice(4, 6) - KST;
}

function ymd(sec: number): string {
  return new Date((sec + KST) * 1000).toISOString().slice(0, 10).replaceAll("-", "");
}

function tradingHours(sec: number): boolean {
  const weekday = new Date((sec + KST) * 1000).getUTCDay();
  return weekday >= 1 && weekday <= 5 && hms(sec) >= EXTENDED.open;
}

function hms(sec: number): string {
  return new Date((sec + KST) * 1000).toISOString().slice(11, 19).replaceAll(":", "");
}
