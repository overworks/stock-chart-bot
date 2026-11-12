import { tracing } from "cloudflare:workers";
import { parseChartArgs } from "./command";
import { buildSvg, summarizeChange } from "./chart";
import { displayCurrency, displayRule, scaleSeries } from "./display";
import { errorMessage, logEvent } from "./log";
import { getPrices, searchRemote, SymbolNotFoundError, type PriceSeries, type Providers } from "./market";
import { svgToPng } from "./render";
import { isAsciiQuery, resolveSymbol, symbolName } from "./symbols";
import type { ChartRequest, OutgoingMessage } from "./types";

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
        svgToPng(buildSvg(bars, `${title} · ${label}`, { timeZone, currency, style: parsed.style, volume: parsed.volume, reference, source, intraday, regularHours })),
      );
      const change = summarizeChange(bars, currency, reference);

      span.setAttributes({ "chart.ticker": parsed.ticker, "chart.symbol": symbol, "chart.range": label, "chart.source": source, "chart.bars": bars.length, "chart.resolved": resolved });
      logEvent("log", "chart_served", {
        ticker: parsed.ticker,
        symbol,
        range: label,
        source,
        bars: bars.length,
        lastBar: new Date(bars[bars.length - 1].t * 1000).toISOString(),
        resolved,
        ms: Date.now() - started,
        pngBytes: png.length,
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
      span.setAttributes({ "chart.ticker": ticker, "chart.symbol": symbol, "chart.failed": reason });
      logEvent(reason === "upstream" ? "error" : "warn", "chart_failed", { ticker, symbol, range, from, to, reason, error: errorMessage(err), ms: Date.now() - started });
      throw err;
    }
  });
}

/** "삼성전자 (005930.KS)", "JPY/KRW (JPYKRW=X, 100엔)", "JPYKRW=X (100엔)", "AAPL" */
export function buildTitle(symbol: string, name?: string, label?: string): string {
  const hasName = !!name && name !== symbol;
  const inner = [hasName ? symbol : undefined, label].filter(Boolean).join(", ");
  const head = hasName ? name! : symbol;
  return inner ? `${head} (${inner})` : head;
}
