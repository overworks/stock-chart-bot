import type { ChartBar, ChartRequest } from "../types";
import { SymbolNotFoundError, type MarketProvider, type PriceSeries } from "./types";

const API = "https://openapi.koreainvestment.com:9443";
const DAILY = "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice";
const MINUTE = "/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice";
const SYMBOL = /^([0-9A-Z]{6})\.(KS|KQ)$/;
const TOKEN_KEY = "kis:token:v1";
const TOKEN_MARGIN = 3600;
const DAILY_PAGE = 100;
const MINUTE_PAGE = 120;
const MAX_DAILY_PAGES = 20;
const MAX_MINUTE_PAGES = 5;
const RATE_LIMITED = "EGW00201";
const KST = 9 * 3600;

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

/** 한국투자증권 Open API. KRX 종목(.KS/.KQ)만 맡고 앱키가 없으면 건너뛴다. */
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

  async function daily(cfg: KisConfig, code: string, period: "D" | "W" | "M", from: string, to: string) {
    const rows: Row[] = [];
    let name: string | undefined;
    let end = to;
    for (let page = 0; ; page++) {
      if (page === MAX_DAILY_PAGES) throw new Error("한국투자증권 조회 기간이 너무 깁니다.");
      const body = await call(cfg, DAILY, "FHKST03010100", {
        FID_COND_MRKT_DIV_CODE: "J",
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: from,
        FID_INPUT_DATE_2: end,
        FID_PERIOD_DIV_CODE: period,
        FID_ORG_ADJ_PRC: "0",
      });
      name ??= body.output1?.hts_kor_isnm?.trim() || undefined;
      const got = (body.output2 ?? []).filter((r) => /^\d{8}$/.test(r.stck_bsop_date ?? ""));
      rows.push(...got);
      const last = got.at(-1)?.stck_bsop_date;
      if (got.length < DAILY_PAGE || !last || last <= from) break;
      end = ymd(dateSec(last) - 86_400);
    }
    if (!rows.length && !name) throw new SymbolNotFoundError(`'${code}' 시세를 한국투자증권에서 찾지 못했습니다.`);
    const bars = dedupe(rows.map((r) => toBar(r, dateSec(r.stck_bsop_date!), r.stck_clpr, r.acml_vol)));
    return { bars, name };
  }

  async function minutes(cfg: KisConfig, code: string, date: string): Promise<ChartBar[]> {
    const today = ymd(Math.floor(now() / 1000)) === date;
    let hour = today ? hms(Math.floor(now() / 1000)) : "153000";
    if (hour > "153000") hour = "153000";
    const rows: Row[] = [];
    for (let page = 0; page < MAX_MINUTE_PAGES; page++) {
      const body = await call(cfg, MINUTE, "FHKST03010230", {
        FID_COND_MRKT_DIV_CODE: "J",
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
      if (all.length < MINUTE_PAGE || got.length < all.length || !earliest || earliest <= "090000") break;
      hour = earliest;
    }
    return dedupe(rows.map((r) => toBar(r, dateSec(date) + clockSec(r.stck_cntg_hour!), r.stck_prpr, r.cntg_vol)));
  }

  const provider: MarketProvider = {
    name: "한국투자증권",

    supports(symbol) {
      return SYMBOL.test(symbol) && config() !== undefined;
    },

    async getPrices(symbol, req: ChartRequest) {
      const cfg = config();
      const code = SYMBOL.exec(symbol)?.[1];
      if (!cfg || !code) throw new Error("한국투자증권 설정이 없습니다.");
      const today = ymd(Math.floor(now() / 1000));

      let bars: ChartBar[];
      let name: string | undefined;
      let previousClose: number | undefined;
      let label: string;
      let intraday = false;

      if (req.from && req.to) {
        label = `${req.from} ~ ${req.to}`;
        ({ bars, name } = await daily(cfg, code, "D", req.from.replaceAll("-", ""), req.to.replaceAll("-", "")));
      } else {
        label = req.range ?? "1d";
        const plan = RANGE[label] ?? RANGE["1d"];
        if ("period" in plan) {
          const from = plan.period === "M" ? "19800101" : ymd(Math.floor(now() / 1000) - plan.days * 86_400);
          ({ bars, name } = await daily(cfg, code, plan.period, from, today));
        } else {
          intraday = true;
          const recent = await daily(cfg, code, "D", ymd(Math.floor(now() / 1000) - 21 * 86_400), today);
          name = recent.name;
          const days = recent.bars.slice(-plan.sessions);
          if (!days.length) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
          if (plan.sessions === 1) previousClose = recent.bars.at(-2)?.c;
          bars = [];
          for (const d of days) bars.push(...bucket(await minutes(cfg, code, ymd(d.t)), plan.minutes * 60));
        }
      }
      if (bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
      return { bars, label, intraday, timeZone: "Asia/Seoul", currency: "KRW", source: provider.name, name, previousClose } satisfies PriceSeries;
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

function toBar(r: Row, t: number, close: string | undefined, volume: string | undefined): ChartBar | undefined {
  const c = num(close);
  if (c === undefined || c === 0) return undefined;
  return { t, c, o: num(r.stck_oprc), h: num(r.stck_hgpr), l: num(r.stck_lwpr), v: num(volume) };
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

function hms(sec: number): string {
  return new Date((sec + KST) * 1000).toISOString().slice(11, 19).replaceAll(":", "");
}
