import { tracing } from "cloudflare:workers";
import { parseChartArgs } from "./command";
import { buildSvg, summarizeChange } from "./chart";
import { buildTitle, displayCurrency, displayRule, scaleSeries } from "./display";
import { exceptionAttributes, logEvent } from "./log";
import { getPrices, searchRemote, SymbolNotFoundError, type PriceSeries, type Providers } from "./market";
import { svgToPng } from "./render";
import { isAsciiQuery, resolveSymbol, symbolName } from "./symbols";
import type { ChartRequest, OutgoingMessage } from "./types";

export { buildTitle };

export interface CoreEnv {
  KV: KVNamespace;
}

const DISPLAY_TZ = "Asia/Seoul";

export function runChart(
  args: Record<string, string | undefined>,
  env: CoreEnv,
  providers: Providers,
): Promise<OutgoingMessage> {
  return tracing.enterSpan("chart", async (span) => {
    const started = Date.now();
    let req: ChartRequest | undefined;
    let symbol = (args.ticker ?? "").trim();
    let resolved: "direct" | "alias" | "search" = "direct";
    try {
      const parsed = (req = parseChartArgs(args));
      symbol = await tracing.enterSpan("chart.resolve", () => resolveSymbol(parsed.ticker, env.KV));
      if (symbol !== parsed.ticker) resolved = "alias";

      let series = await tracing.enterSpan("chart.prices", async (): Promise<PriceSeries> => {
        try {
          return await getPrices(symbol, parsed, providers);
        } catch (err) {
          // 별칭으로 해석되지 않은 영문 입력이 '없는 심볼'일 때만 검색으로 한 번 더 시도한다.
          if (!(err instanceof SymbolNotFoundError) || resolved !== "direct" || !isAsciiQuery(symbol)) throw err;
          const hit = (await searchRemote(symbol, providers))[0];
          if (!hit) throw err;
          symbol = hit.value;
          resolved = "search";
          return getPrices(symbol, parsed, providers);
        }
      });

      const rule = displayRule(symbol);
      if (rule) series = scaleSeries(series, rule.factor);
      const { bars, label, previousClose, source, intraday, regularHours } = series;
      const currency = displayCurrency(symbol, series.currency);
      const timeZone = series.continuous ? DISPLAY_TZ : series.timeZone;
      const name = (await symbolName(symbol, env.KV)) ?? series.name;
      const title = buildTitle(symbol, name, rule?.label);
      const reference = parsed.range === "1d" && !parsed.from ? previousClose : undefined;
      const png = await tracing.enterSpan("chart.render", () =>
        svgToPng(buildSvg(bars, title, { period: label, timeZone, currency, style: parsed.style, volume: parsed.volume, reference, source, intraday, regularHours })),
      );
      const change = summarizeChange(bars, currency, reference);

      const attributes = { "chart.ticker": parsed.ticker, "chart.symbol": symbol, "chart.range": label, "chart.source": source, "chart.bars": bars.length, "chart.resolved": resolved };
      span.setAttributes(attributes);
      logEvent("log", "chart.served", {
        ...attributes,
        "chart.last_bar": new Date(bars[bars.length - 1].t * 1000).toISOString(),
        "chart.duration_ms": Date.now() - started,
        "chart.image.size": png.length,
      });
      return {
        text: `**${title}** ${label} · ${change.text}`,
        image: { png, filename: "chart.png" },
        color: change.color,
        source,
      };
    } catch (err) {
      const reason = !req ? "invalid_args" : err instanceof SymbolNotFoundError ? "not_found" : "upstream";
      const { ticker, range, from, to } = req ?? args;
      const attributes = { "chart.ticker": ticker, "chart.symbol": symbol, "error.type": reason };
      span.setAttributes(attributes);
      logEvent(reason === "upstream" ? "error" : "warn", "chart.failed", {
        ...attributes,
        "chart.range": range,
        "chart.from": from,
        "chart.to": to,
        ...exceptionAttributes(err),
        "chart.duration_ms": Date.now() - started,
      });
      throw err;
    }
  });
}
