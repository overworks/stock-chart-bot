import type { PriceSeries } from "./providers/types";

/** 시세를 관행 단위로 바꿔 보여주는 심볼. factor를 곱하고 제목에 label을 붙인다. */
const DISPLAY: Record<string, { factor: number; label: string }> = {
  "JPYKRW=X": { factor: 100, label: "100엔" },
};

export function displayRule(symbol: string): { factor: number; label: string } | undefined {
  return DISPLAY[symbol];
}

export function scaleSeries(series: PriceSeries, factor: number): PriceSeries {
  if (factor === 1) return series;
  const mul = (n: number | undefined) => (n === undefined ? undefined : Number((n * factor).toFixed(6)));
  return {
    ...series,
    bars: series.bars.map((b) => ({ ...b, c: mul(b.c)!, o: mul(b.o), h: mul(b.h), l: mul(b.l) })),
    previousClose: mul(series.previousClose),
  };
}
