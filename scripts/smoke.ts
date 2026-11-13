import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createResvgRenderer } from "../src/rendering/resvg";
import { getPrices } from "../src/core/market";
import { buildSvg } from "../src/core/chart";
import { RANGE_CHOICES } from "../src/core/command";
import { buildTitle, displayCurrency, displayRule, scaleSeries } from "../src/core/display";
import { createProviders } from "../src/providers";

const outDir = process.env.OUT_DIR ?? "dist/smoke";
const cases = (process.argv[2] ?? "AAPL:1y,005930.KS:1m,AAPL:1d").split(",");

const renderPng = createResvgRenderer(async () => ({
  wasm: readFileSync("wasm/resvg.wasm"),
  fonts: ["fonts/NanumSquareR.ttf", "fonts/NanumSquareB.ttf"].map((file) => new Uint8Array(readFileSync(file))),
}));
mkdirSync(outDir, { recursive: true });
const providers = createProviders({ kisAppKey: process.env.KIS_APP_KEY, kisAppSecret: process.env.KIS_APP_SECRET });

for (const c of cases) {
  const [sym, range = "1d", ...flags] = c.split(":");
  const style = flags.includes("candle") ? "candle" : "line";
  const volume = flags.includes("volume");
  if (!(RANGE_CHOICES as readonly string[]).includes(range)) {
    console.log(`FAIL ${sym} ${range}: 알 수 없는 range`);
    continue;
  }
  try {
    let series = await getPrices(sym, { ticker: sym, range }, providers);
    const rule = displayRule(sym);
    if (rule) series = scaleSeries(series, rule.factor);
    const { bars, label, name, previousClose, source, intraday, regularHours } = series;
    const currency = displayCurrency(sym, series.currency);
    const timeZone = series.continuous ? "Asia/Seoul" : series.timeZone;
    const title = process.env.TITLE ?? buildTitle(sym, name, rule?.label);
    const reference = range === "1d" ? previousClose : undefined;
    const svg = buildSvg(bars, title, { period: label, timeZone, currency, style, volume, reference, source, intraday, regularHours });
    const png = await renderPng(svg);
    const out = `${outDir}/${sym}-${range}${style === "candle" ? "-candle" : ""}${volume ? "-volume" : ""}.png`;
    writeFileSync(out, png);
    console.log(`OK   ${sym} ${range} bars=${bars.length} png=${png.length}B -> ${out}`);
  } catch (e) {
    console.log(`FAIL ${sym} ${range}: ${(e as Error).message}`);
  }
}
