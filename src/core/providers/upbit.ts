import type { ChartBar, ChartRequest } from "../types";
import { SymbolNotFoundError, type MarketProvider, type PriceSeries, type SymbolChoice } from "./types";

const API = "https://api.upbit.com/v1";
const PAGE = 200;
const MAX_BARS = 2000;
const MARKET = /^KRW-[A-Z0-9]+$/;

const RANGE: Record<string, { path: string; count: number; intraday: boolean }> = {
  "1d": { path: "minutes/5", count: 288, intraday: true },
  "1w": { path: "minutes/30", count: 336, intraday: true },
  "1m": { path: "days", count: 30, intraday: false },
  "3m": { path: "days", count: 90, intraday: false },
  "6m": { path: "days", count: 180, intraday: false },
  "1y": { path: "days", count: 365, intraday: false },
  "5y": { path: "weeks", count: 261, intraday: false },
  max: { path: "months", count: PAGE, intraday: false },
};

interface Candle {
  candle_date_time_utc: string;
  opening_price: number;
  high_price: number;
  low_price: number;
  trade_price: number;
  candle_acc_trade_volume?: number;
  prev_closing_price?: number;
}

/** 업비트 원화 마켓(KRW-BTC). 시세는 인증 없이 조회할 수 있고 요청당 200개까지 온다. */
export const upbit: MarketProvider = {
  name: "Upbit",

  supports(symbol) {
    return MARKET.test(symbol);
  },

  async getPrices(symbol, req) {
    const plan = buildPlan(req);
    const rows = await fetchCandles(symbol, plan.path, plan.count, plan.to);
    let bars = rows.map(toBar).filter((b): b is ChartBar => b !== undefined).reverse();
    if (plan.since !== undefined) bars = bars.filter((b) => b.t >= plan.since!);
    if (bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);

    let previousClose: number | undefined;
    if (plan.label === "1d") {
      const day = (await fetchCandles(symbol, "days", 1))[0];
      previousClose = finite(day?.prev_closing_price);
    }
    return {
      bars,
      label: plan.label,
      intraday: plan.intraday,
      timeZone: "Asia/Seoul",
      currency: "KRW",
      source: upbit.name,
      previousClose,
      continuous: true,
    } satisfies PriceSeries;
  },

  // 영문 질의는 Yahoo가 맡는다. 한글 이름이나 KRW- 마켓 코드일 때만 목록을 받는다.
  async search(query) {
    const q = query.trim();
    if (!/[가-힣]/.test(q) && !/^krw-/i.test(q)) return [];
    let markets: { market: string; korean_name: string }[];
    try {
      const res = await fetch(`${API}/market/all?is_details=false`, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
      if (!res.ok) return [];
      markets = await res.json();
    } catch {
      return [];
    }
    if (!Array.isArray(markets)) return [];
    const norm = q.toLowerCase().replace(/\s+/g, "");
    return markets
      .filter((m) => MARKET.test(m.market) && (m.korean_name.replace(/\s+/g, "").includes(norm) || m.market.toLowerCase() === norm))
      .slice(0, 25)
      .map((m): SymbolChoice => ({ name: `${m.korean_name} (${m.market}, Upbit)`, value: m.market }));
  },
};

function buildPlan(req: ChartRequest): { path: string; count: number; to?: string; since?: number; label: string; intraday: boolean } {
  if (req.from && req.to) {
    const since = Math.floor(Date.parse(req.from) / 1000);
    const until = Math.floor(Date.parse(req.to) / 1000) + 86_400;
    const count = Math.min(MAX_BARS, Math.ceil((until - since) / 86_400));
    return { path: "days", count, to: iso(until), since, label: `${req.from} ~ ${req.to}`, intraday: false };
  }
  const label = req.range ?? "1d";
  return { ...(RANGE[label] ?? RANGE["1d"]), label };
}

async function fetchCandles(market: string, path: string, count: number, to?: string): Promise<Candle[]> {
  const out: Candle[] = [];
  let cursor = to;
  while (out.length < count) {
    const n = Math.min(PAGE, count - out.length);
    const url = `${API}/candles/${path}?market=${encodeURIComponent(market)}&count=${n}${cursor ? `&to=${encodeURIComponent(cursor)}` : ""}`;
    const res = await fetch(url, { cf: { cacheTtl: 60, cacheEverything: true } } as RequestInit);
    if (res.status === 404) throw new SymbolNotFoundError(`'${market}' 마켓을 업비트에서 찾지 못했습니다.`);
    if (res.status === 429) throw new Error("업비트 요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.");
    if (!res.ok) throw new Error(`시세 조회 실패 (${res.status})`);
    let rows: unknown;
    try {
      rows = await res.json();
    } catch {
      throw new Error("시세 응답을 해석하지 못했습니다.");
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...(rows as Candle[]));
    if (rows.length < n) break;
    cursor = `${out[out.length - 1].candle_date_time_utc}Z`;
  }
  return out;
}

function toBar(row: Candle): ChartBar | undefined {
  const t = Date.parse(`${row?.candle_date_time_utc}Z`);
  const c = finite(row?.trade_price);
  if (!Number.isFinite(t) || c === undefined) return undefined;
  return { t: Math.floor(t / 1000), c, o: finite(row.opening_price), h: finite(row.high_price), l: finite(row.low_price), v: finite(row.candle_acc_trade_volume) };
}

function finite(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function iso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
