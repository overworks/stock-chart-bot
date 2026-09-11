import { parseChartArgs } from "./command";
import { buildSvg, summarizeChange } from "./chart";
import { displayRule, scaleSeries } from "./display";
import { getPrices, searchRemote, SymbolNotFoundError, type PriceSeries } from "./market";
import { svgToPng } from "./render";
import { isAsciiQuery, resolveSymbol, symbolName } from "./symbols";
import type { OutgoingMessage } from "./types";

export interface CoreEnv {
  SYMBOLS: KVNamespace;
}

const DISPLAY_TZ = "Asia/Seoul";

export async function runChart(
  args: Record<string, string | undefined>,
  env: CoreEnv,
): Promise<OutgoingMessage> {
  const req = parseChartArgs(args);
  let symbol = await resolveSymbol(req.ticker, env.SYMBOLS);

  let series: PriceSeries;
  try {
    series = await getPrices(symbol, req);
  } catch (err) {
    // 별칭으로 해석되지 않은 영문 입력이 '없는 심볼'일 때만 검색으로 한 번 더 시도한다.
    const unresolved = symbol === req.ticker.trim();
    if (!(err instanceof SymbolNotFoundError) || !unresolved || !isAsciiQuery(symbol)) throw err;
    const hit = (await searchRemote(symbol))[0];
    if (!hit) throw err;
    symbol = hit.value;
    series = await getPrices(symbol, req);
  }

  const rule = displayRule(symbol);
  if (rule) series = scaleSeries(series, rule.factor);
  const { bars, label, currency, previousClose, source, intraday } = series;
  const timeZone = series.continuous ? DISPLAY_TZ : series.timeZone;
  const name = (await symbolName(symbol, env.SYMBOLS)) ?? series.name;
  const title = buildTitle(symbol, name, rule?.label);
  const reference = req.range === "1d" && !req.from ? previousClose : undefined;
  const svg = buildSvg(bars, `${title} · ${label}`, { timeZone, currency, style: req.style, reference, source, intraday });
  const png = await svgToPng(svg);
  const change = summarizeChange(bars, currency, reference);

  return {
    text: `**${title}** ${label} · ${change.text}`,
    image: { png, filename: "chart.png" },
    color: change.color,
    source,
  };
}

/** "삼성전자 (005930.KS)", "JPY/KRW (JPYKRW=X, 100엔)", "JPYKRW=X (100엔)", "AAPL" */
export function buildTitle(symbol: string, name?: string, label?: string): string {
  const hasName = !!name && name !== symbol;
  const inner = [hasName ? symbol : undefined, label].filter(Boolean).join(", ");
  const head = hasName ? name! : symbol;
  return inner ? `${head} (${inner})` : head;
}
