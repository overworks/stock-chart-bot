import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { getPrices } from "../src/core/market";
import { buildSvg } from "../src/core/chart";

const outDir = process.env.OUT_DIR ?? "dist/smoke";
const cases = (process.argv[2] ?? "AAPL:1y,005930.KS:1m,AAPL:1d").split(",");

await initWasm(readFileSync("wasm/resvg.wasm"));
const fonts = ["fonts/NanumSquareR.ttf", "fonts/NanumSquareB.ttf"].map((f) => new Uint8Array(readFileSync(f)));
mkdirSync(outDir, { recursive: true });

for (const c of cases) {
  const [sym, range = "1y", style = "line"] = c.split(":");
  try {
    const { bars, label, timeZone, currency } = await getPrices(sym, { ticker: sym, range });
    const svg = buildSvg(bars, `${process.env.TITLE ?? sym} · ${label}`, { timeZone, currency, style: style as "line" | "candle" });
    const png = new Resvg(svg, {
      fitTo: { mode: "width", value: 900 },
      font: { fontBuffers: fonts, defaultFontFamily: "NanumSquare", loadSystemFonts: false },
    }).render().asPng();
    const out = `${outDir}/${sym}-${range}${style === "candle" ? "-candle" : ""}.png`;
    writeFileSync(out, png);
    console.log(`OK   ${sym} ${range} bars=${bars.length} png=${png.length}B -> ${out}`);
  } catch (e) {
    console.log(`FAIL ${sym} ${range}: ${(e as Error).message}`);
  }
}
