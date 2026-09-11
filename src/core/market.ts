import { yahoo } from "./providers/yahoo";
import type { ChartRequest } from "./types";
import type { MarketProvider, PriceSeries, SymbolChoice } from "./providers/types";

export { SymbolNotFoundError } from "./providers/types";
export type { MarketProvider, PriceSeries, SymbolChoice } from "./providers/types";

/** 앞에서부터 시도하고 실패하면 다음 제공자로 넘어간다. */
export const PROVIDERS: readonly MarketProvider[] = [yahoo];

export async function getPrices(
  symbol: string,
  req: ChartRequest,
  providers: readonly MarketProvider[] = PROVIDERS,
): Promise<PriceSeries> {
  let firstError: unknown;
  for (const p of providers) {
    try {
      const series = await p.getPrices(symbol, req);
      if (series.bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
      return series;
    } catch (err) {
      firstError ??= err;
    }
  }
  throw firstError ?? new Error("사용 가능한 시세 제공자가 없습니다.");
}

export async function searchRemote(
  query: string,
  providers: readonly MarketProvider[] = PROVIDERS,
): Promise<SymbolChoice[]> {
  for (const p of providers) {
    try {
      const hits = await p.search(query);
      if (hits.length) return hits;
    } catch {
      continue;
    }
  }
  return [];
}
