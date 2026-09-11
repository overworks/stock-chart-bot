export const RANGE_CHOICES = [
  "1d",
  "1w",
  "1m",
  "3m",
  "6m",
  "1y",
  "5y",
  "max",
] as const;

export type RangeChoice = (typeof RANGE_CHOICES)[number];

export function parseChartArgs(
  args: Record<string, string | undefined>,
): import("./types").ChartRequest {
  const ticker = (args.ticker ?? "").trim();
  if (!ticker) throw new Error("종목(ticker)을 입력해 주세요.");

  const from = args.from?.trim();
  const to = args.to?.trim();
  const range = args.range?.trim();

  if ((from && !to) || (!from && to)) {
    throw new Error("커스텀 기간은 시작일과 종료일을 함께 입력해 주세요.");
  }
  if (from && to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      throw new Error("날짜 형식은 YYYY-MM-DD 이어야 합니다.");
    }
    if (Date.parse(from) >= Date.parse(to)) {
      throw new Error("시작일은 종료일보다 앞서야 합니다.");
    }
    return { ticker, from, to };
  }

  return {
    ticker,
    range: (RANGE_CHOICES as readonly string[]).includes(range ?? "")
      ? range
      : "1y",
  };
}
