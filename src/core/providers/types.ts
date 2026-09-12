import type { ChartBar, ChartRequest } from "../types";

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
}

export interface SymbolChoice {
  name: string;
  value: string;
}

export interface MarketProvider {
  readonly name: string;
  /** 없으면 모든 심볼을 시도한다. 있으면 true인 심볼만 이 제공자로 보낸다. */
  supports?(symbol: string): boolean;
  getPrices(symbol: string, req: ChartRequest): Promise<PriceSeries>;
  search(query: string): Promise<SymbolChoice[]>;
}
