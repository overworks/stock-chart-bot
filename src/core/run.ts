import { parseChartArgs } from "./command";
import { buildSvg } from "./chart";
import { getPrices, resolveSymbol } from "./market";
import { svgToPng } from "./render";
import type { OutgoingMessage } from "./types";

export interface CoreEnv {
  SYMBOLS: KVNamespace;
}

export async function runChart(
  args: Record<string, string | undefined>,
  env: CoreEnv,
): Promise<OutgoingMessage> {
  const req = parseChartArgs(args);
  const symbol = await resolveSymbol(req.ticker, env.SYMBOLS);
  const { bars, label, timeZone } = await getPrices(symbol, req);

  const svg = buildSvg(bars, `${req.ticker} (${label})`, timeZone);
  const png = await svgToPng(svg);

  return {
    text: `**${req.ticker}** ${label}`,
    image: { png, filename: "chart.png" },
  };
}
