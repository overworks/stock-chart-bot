import type { ChartBar, ChartRequest } from "./types";

const YAHOO = "https://query1.finance.yahoo.com/v8/finance/chart";

const INTERVAL: Record<string, string> = {
  "1d": "5m",
  "1w": "30m",
  "1m": "1d",
  "3m": "1d",
  "6m": "1d",
  "1y": "1d",
  "5y": "1wk",
  max: "1mo",
};

export interface PriceSeries {
  bars: ChartBar[];
  label: string;
}

export async function resolveSymbol(
  ticker: string,
  symbols: KVNamespace,
): Promise<string> {
  const mapped = await symbols.get(ticker);
  return mapped ?? ticker;
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
  if (!result) throw new Error(`'${symbol}' 시세를 찾지 못했습니다.`);

  const timestamps: number[] = result.timestamp ?? [];
  const closes: (number | null)[] = result.indicators?.quote?.[0]?.close ?? [];
  const bars: ChartBar[] = timestamps
    .map((t, i) => ({ t, c: closes[i] }))
    .filter((b): b is ChartBar => typeof b.c === "number");

  if (bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
  return { bars, label };
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
  const range = req.range ?? "1y";
  const interval = INTERVAL[range] ?? "1d";
  return {
    url: `${YAHOO}/${sym}?range=${range}&interval=${interval}`,
    label: range,
  };
}
