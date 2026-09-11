import type { ChartBar, ChartRequest } from "./types";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

const YAHOO_RANGE: Record<string, { range: string; interval: string }> = {
  "1d": { range: "1d", interval: "5m" },
  "1w": { range: "5d", interval: "30m" },
  "1m": { range: "1mo", interval: "1d" },
  "3m": { range: "3mo", interval: "1d" },
  "6m": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  "5y": { range: "5y", interval: "1wk" },
  max: { range: "max", interval: "1mo" },
};

export class SymbolNotFoundError extends Error {}

export interface PriceSeries {
  bars: ChartBar[];
  label: string;
  timeZone: string;
  currency: string;
}

export async function getPrices(
  symbol: string,
  req: ChartRequest,
): Promise<PriceSeries> {
  const { url, label } = buildUrl(symbol, req);

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 stock-chart-bot" },
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);

  if (!res.ok) throw new Error(`시세 조회 실패 (${res.status})`);

  const json = (await res.json()) as any;
  const result = json?.chart?.result?.[0];
  if (!result) throw new SymbolNotFoundError(`'${symbol}' 시세를 찾지 못했습니다.`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  const bars: ChartBar[] = timestamps
    .map((t, i) => ({ t, c: closes[i] }))
    .filter((b): b is ChartBar => typeof b.c === "number");

  if (bars.length < 2) throw new SymbolNotFoundError(`'${symbol}' 데이터가 부족합니다.`);
  const timeZone: string = result.meta?.exchangeTimezoneName ?? "UTC";
  const currency: string = result.meta?.currency ?? "";
  return { bars, label, timeZone, currency };
}

function buildUrl(symbol: string, req: ChartRequest) {
  const sym = encodeURIComponent(symbol);
  if (req.from && req.to) {
    const p1 = Math.floor(Date.parse(req.from) / 1000);
    const p2 = Math.floor(Date.parse(req.to) / 1000) + 86_400;
    return {
      url: `${YAHOO}/${sym}?period1=${p1}&period2=${p2}&interval=1d`,
      label: `${req.from} ~ ${req.to}`,
    };
  }
  const label = req.range ?? "1y";
  const { range, interval } = YAHOO_RANGE[label] ?? YAHOO_RANGE["1y"];
  return {
    url: `${YAHOO}/${sym}?range=${range}&interval=${interval}`,
    label,
  };
}
