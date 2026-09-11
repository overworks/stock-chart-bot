import { parseChartArgs } from "./command";
import { buildSvg } from "./chart";
import { getPrices, SymbolNotFoundError, type PriceSeries } from "./market";
import { svgToPng } from "./render";
import { isAsciiQuery, resolveSymbol, searchYahoo } from "./symbols";
import type { OutgoingMessage } from "./types";

export interface CoreEnv {
  SYMBOLS: KVNamespace;
}

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
    const hit = (await searchYahoo(req.ticker))[0];
    if (!hit) throw err;
    symbol = hit.value;
    series = await getPrices(symbol, req);
  }

  const { bars, label, timeZone } = series;
  const title = symbol === req.ticker ? req.ticker : `${req.ticker} (${symbol})`;
  const svg = buildSvg(bars, `${title} · ${label}`, timeZone);
  const png = await svgToPng(svg);

  return {
    text: `**${title}** ${label}`,
    image: { png, filename: "chart.png" },
  };
}
