import type { ChartBar, ChartRequest, TimeSpan } from "../core/types";
import { exceptionAttributes, logEvent } from "../core/log";
import { SymbolNotFoundError, type MarketProvider, type PriceSeries, type SymbolChoice } from "../core/market";

const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";
const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const UA = "Mozilla/5.0 stock-chart-bot";
const MAX_SEARCH = 25;
const QUOTE_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);
const CONTINUOUS_TYPES = new Set(["CRYPTOCURRENCY", "CURRENCY"]);

/** prePost: 미국 주식의 프리마켓(04:00~)·애프터마켓(~20:00 ET) 봉을 포함한다. 그 외 시장은 응답이 같다. */
const RANGE: Record<string, { range: string; interval: string; prePost?: boolean }> = {
  "1d": { range: "1d", interval: "5m", prePost: true },
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
    const { url, label, intraday, prePost } = buildUrl(symbol, req);
    let { result, bars } = await load(url, symbol);
    let meta = result.meta ?? {};
    const timeZone: string = meta.exchangeTimezoneName ?? "UTC";
    let regularHours = prePost ? regularPeriods(meta.tradingPeriods) : undefined;
    let prev = meta.chartPreviousClose ?? meta.previousClose;

    if (prePost && bars.length < 2) {
      // 새 거래일로 넘어간 직후에는 1d 응답에 봉이 없다. 5d에서 마지막 세션을 잘라 쓴다.
      const today = bars.length;
      const wide = await load(`${CHART}/${encodeURIComponent(symbol)}?range=5d&interval=5m&includePrePost=true`, symbol);
      meta = wide.result.meta ?? {};
      const offset = typeof meta.gmtoffset === "number" && Number.isFinite(meta.gmtoffset) ? meta.gmtoffset : 0;
      bars = lastSession(wide.bars, offset);
      regularHours = regularPeriods(meta.tradingPeriods);
      const first = bars[0]?.t ?? 0;
      prev = wide.bars.filter((b) => b.t < first && regularHours?.some((r) => r.start <= b.t && b.t <= r.end)).at(-1)?.c;
      logEvent("log", "chart.session.fallback", {
        "chart.provider.name": "yahoo",
        "chart.symbol": symbol,
        "chart.bars": today,
        "chart.session.date": bars.length ? new Date((first + offset) * 1000).toISOString().slice(0, 10) : undefined,
        "chart.session.ok": bars.length >= 2,
      });
    } else if (prePost && typeof meta.regularMarketTime === "number" && day(bars[bars.length - 1].t, timeZone) > day(meta.regularMarketTime, timeZone)) {
      // 프리마켓에는 오늘 봉만 오는데 chartPreviousClose는 직전 정규장의 전일 종가로 남아 있다.
      prev = meta.regularMarketPrice;
    }
    if (bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);

    return {
      bars,
      label,
      intraday,
      timeZone,
      currency: meta.currency ?? "",
      source: yahoo.name,
      name: meta.shortName ?? meta.longName ?? undefined,
      previousClose: typeof prev === "number" && Number.isFinite(prev) ? prev : undefined,
      continuous: CONTINUOUS_TYPES.has(meta.instrumentType),
      regularHours,
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
    } catch (err) {
      logEvent("warn", "chart.search.failed", { "chart.provider.name": "yahoo", ...exceptionAttributes(err) });
      return [];
    }
    if (!res.ok) {
      logEvent("warn", "chart.search.failed", { "chart.provider.name": "yahoo", "http.response.status_code": res.status });
      return [];
    }

    let json: any;
    try {
      json = await res.json();
    } catch {
      return [];
    }
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

async function load(url: string, symbol: string): Promise<{ result: any; bars: ChartBar[] }> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  // 모르는 심볼은 404 + {chart:{result:null}} 로 온다.
  if (res.status === 404) throw new SymbolNotFoundError(`'${symbol}' 시세를 찾지 못했습니다.`);
  if (!res.ok) throw new Error(`시세 조회 실패 (${res.status})`);

  let json: any;
  try {
    json = await res.json();
  } catch {
    throw new Error("시세 응답을 해석하지 못했습니다.");
  }
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
  return { result, bars };
}

/** 거래소 현지 날짜로 나눠 봉이 2개 이상인 가장 최근 날짜의 봉을 돌려준다. */
function lastSession(bars: ChartBar[], offset: number): ChartBar[] {
  const key = (t: number) => Math.floor((t + offset) / 86_400);
  for (let end = bars.length; end > 0; ) {
    const k = key(bars[end - 1].t);
    let start = end - 1;
    while (start > 0 && key(bars[start - 1].t) === k) start--;
    if (end - start >= 2) return bars.slice(start, end);
    end = start;
  }
  return [];
}

function num(arr: unknown, i: number): number | undefined {
  const x = Array.isArray(arr) ? arr[i] : undefined;
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}

// includePrePost 응답은 { pre, regular, post }, 시간외가 없는 시장은 [[{ start, end }]] 형태다.
function regularPeriods(periods: any): TimeSpan[] | undefined {
  const list = Array.isArray(periods) ? periods : periods?.regular;
  if (!Array.isArray(list)) return undefined;
  const spans = list
    .flat()
    .filter((p: any) => Number.isFinite(p?.start) && Number.isFinite(p?.end))
    .map((p: any): TimeSpan => ({ start: p.start, end: p.end }));
  return spans.length ? spans : undefined;
}

function day(sec: number, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(sec * 1000));
}

function buildUrl(symbol: string, req: ChartRequest) {
  const sym = encodeURIComponent(symbol);
  if (req.from && req.to) {
    const p1 = Math.floor(Date.parse(req.from) / 1000);
    const p2 = Math.floor(Date.parse(req.to) / 1000) + 86_400;
    return { url: `${CHART}/${sym}?period1=${p1}&period2=${p2}&interval=1d`, label: `${req.from} ~ ${req.to}`, intraday: false, prePost: false };
  }
  const label = req.range ?? "1d";
  const { range, interval, prePost = false } = RANGE[label] ?? RANGE["1d"];
  const extra = prePost ? "&includePrePost=true" : "";
  return { url: `${CHART}/${sym}?range=${range}&interval=${interval}${extra}`, label, intraday: /^\d+[mh]$/.test(interval), prePost };
}
