import { errorMessage, logEvent } from "./log";
import type { ChartBar, ChartRequest, TimeSpan } from "./types";

export class SymbolNotFoundError extends Error {}

export interface PriceSeries {
  bars: ChartBar[];
  label: string;
  /** 분·시간 단위 봉인지. x축 시각 표시와 이동평균 생략에 쓴다. */
  intraday: boolean;
  timeZone: string;
  currency: string;
  source: string;
  name?: string;
  previousClose?: number;
  /** 24시간 거래 상품(환율, 암호화폐). 표시 타임존을 사용자 기준으로 바꾼다. */
  continuous?: boolean;
  /** 정규장 구간. 있으면 그 밖의 봉을 프리마켓·애프터마켓으로 보고 차트에 음영을 넣는다. */
  regularHours?: TimeSpan[];
}

export interface SymbolChoice {
  name: string;
  value: string;
}

/** 구현체는 `src/providers/*`에 두고 진입점에서 조립해 넘긴다. */
export interface MarketProvider {
  readonly name: string;
  /** 없으면 모든 심볼을 시도한다. 있으면 true인 심볼만 이 제공자로 보낸다. */
  supports?(symbol: string): boolean;
  getPrices(symbol: string, req: ChartRequest): Promise<PriceSeries>;
  search(query: string): Promise<SymbolChoice[]>;
}

/** 우선순위 순서의 제공자 목록 */
export type Providers = readonly MarketProvider[];

/** 심볼을 지원하는 제공자를 앞에서부터 시도하고 실패하면 다음으로 넘어간다. */
export async function getPrices(
  symbol: string,
  req: ChartRequest,
  providers: Providers,
): Promise<PriceSeries> {
  let firstError: unknown;
  for (const p of providers.filter((p) => !p.supports || p.supports(symbol))) {
    try {
      const series = await p.getPrices(symbol, req);
      if (series.bars.length < 2) throw new Error(`'${symbol}' 데이터가 부족합니다.`);
      return series;
    } catch (err) {
      firstError ??= err;
      logEvent("warn", "provider_failed", { provider: p.name, symbol, range: req.range, from: req.from, to: req.to, notFound: err instanceof SymbolNotFoundError || undefined, error: errorMessage(err) });
    }
  }
  throw firstError ?? new Error("사용 가능한 시세 제공자가 없습니다.");
}

export async function searchRemote(
  query: string,
  providers: Providers,
): Promise<SymbolChoice[]> {
  for (const p of providers) {
    try {
      const hits = await p.search(query);
      if (hits.length) return hits;
    } catch (err) {
      logEvent("warn", "search_failed", { provider: p.name, error: errorMessage(err) });
    }
  }
  return [];
}
