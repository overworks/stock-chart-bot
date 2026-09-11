import { parseChartArgs } from "./command";
import { buildSvg, summarizeChange } from "./chart";
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
    if (!(err instanceof SymbolNotFoundError) || !isAsciiQuery(req.ticker)) throw err;
    const hit = (await searchRemote(req.ticker))[0];
    if (!hit) throw err;
    symbol = hit.value;
    series = await getPrices(symbol, req);
  }

  const { bars, label, currency, previousClose, source } = series;
  const timeZone = series.continuous ? DISPLAY_TZ : series.timeZone;
  const name = (await symbolName(symbol, env.SYMBOLS)) ?? series.name;
  const title = name && name !== symbol ? `${name} (${symbol})` : symbol;
  const reference = req.range === "1d" && !req.from ? previousClose : undefined;
  const svg = buildSvg(bars, `${title} · ${label}`, { timeZone, currency, style: req.style, reference, source });
  const png = await svgToPng(svg);
  const change = summarizeChange(bars, currency, reference);

  return {
    text: `**${title}** ${label} · ${change.text}`,
    image: { png, filename: "chart.png" },
    color: change.color,
    source,
  };
}
