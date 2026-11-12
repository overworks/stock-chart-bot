export type ChartStyle = "line" | "candle";

export interface ChartRequest {
  ticker: string;
  range?: string;
  from?: string;
  to?: string;
  style?: ChartStyle;
  /** 하단 거래량 막대. 기본은 표시하지 않는다. */
  volume?: boolean;
}

export interface ChartBar {
  t: number;
  c: number;
  o?: number;
  h?: number;
  l?: number;
  v?: number;
}

/** epoch 초 구간. 양끝을 포함한다. */
export interface TimeSpan {
  start: number;
  end: number;
}

export interface OutgoingMessage {
  text: string;
  image?: { png: Uint8Array; filename: string };
  color?: string;
  source?: string;
}
