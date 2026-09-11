import type { ChartBar, ChartRequest } from "../types";
import { SymbolNotFoundError, type MarketProvider, type PriceSeries, type SymbolChoice } from "./types";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const UA = "Mozilla/5.0 stock-chart-bot";
const MAX_SEARCH = 25;
const QUOTE_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);
const CONTINUOUS_TYPES = new Set(["CRYPTOCURRENCY", "CURRENCY"]);

const RANGE: Record<string, { range: string; interval: string }> = {
  "1d": { range: "1d", interval: "5m" },
  "1w": { range: "5d", interval: "30m" },
  "1m": { range: "1mo", interval: "1d" },
  "3m": { range: "3mo", interval: "1d" },
  "6m": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "5y": { range: "5y", interval: "1wk" },
  max: { range: "max", interval: "1mo" },
};

export const yahoo: MarketProvider = {
  name: "Yahoo Finance",

  async getPrices(symbol, req) {
    const { url, label } = buildUrl(symbol, req);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      cf: { cacheTtl: 300, cacheEverything: true },
    } as RequestInit);
    if (!res.ok) throw new Error(`시세 조회 실패 (${res.status})`);

    const json = (await res.json()) as any;
    const result = json?.chart?.result?.[0];
    if (!result) throw new SymbolNotFoundError(`'${symbol}' 시세를 찾지 못했습니다.`);

    const timestamps: number[] = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const bars: ChartBar[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const c = num(quote.close, i);
      if (c === undefined) continue;
      bars.push({ t: timestamps[i], c, o: num(quote.open, i), h: num(quote.high, i), l: num(quote.low, i), v: num(quote.volume, i) });
    }
    if (bars.length < 2) throw new SymbolNotFoundError(`'${symbol}' 데이터가 부족합니다.`);

    const meta = result.meta ?? {};
    const prev = meta.chartPreviousClose ?? meta.previousClose;
    return {
      bars,
      label,
      timeZone: meta.exchangeTimezoneName ?? "UTC",
      currency: meta.currency ?? "",
      source: yahoo.name,
      name: meta.shortName ?? meta.longName ?? undefined,
      previousClose: typeof prev === "number" && Number.isFinite(prev) ? prev : undefined,
      continuous: CONTINUOUS_TYPES.has(meta.instrumentType),
    };
  },

  async search(query) {
    const url = `${SEARCH}?q=${encodeURIComponent(query)}&quotesCount=${MAX_SEARCH}&newsCount=0&listsCount=0`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": UA },
        cf: { cacheTtl: 3600, cacheEverything: true },
      } as RequestInit);
    } catch {
      return [];
    }
    if (!res.ok) return [];

    const json = (await res.json()) as any;
    const quotes: any[] = json?.quotes ?? [];
    return quotes
      .filter((x) => typeof x?.symbol === "string" && QUOTE_TYPES.has(x.quoteType))
      .map((x): SymbolChoice => {
        const label = x.shortname ?? x.longname ?? x.symbol;
        const exch = x.exchDisp ?? x.exchange;
        return { name: `${label} (${x.symbol}${exch ? `, ${exch}` : ""})`.slice(0, 100), value: x.symbol };
      });
  },
};

function num(arr: unknown, i: number): number | undefined {
  const x = Array.isArray(arr) ? arr[i] : undefined;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

function buildUrl(symbol: string, req: ChartRequest) {
  const sym = encodeURIComponent(symbol);
  if (req.from && req.to) {
    const p1 = Math.floor(Date.parse(req.from) / 1000);
    const p2 = Math.floor(Date.parse(req.to) / 1000) + 86_400;
    return { url: `${CHART}/${sym}?period1=${p1}&period2=${p2}&interval=1d`, label: `${req.from} ~ ${req.to}` };
  }
  const label = req.range ?? "1d";
  const { range, interval } = RANGE[label] ?? RANGE["1d"];
  return { url: `${CHART}/${sym}?range=${range}&interval=${interval}`, label };
}
