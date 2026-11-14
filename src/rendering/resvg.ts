import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { CHART_WIDTH, FONT_FAMILY } from "../core/chart.ts";
import type { ChartRenderer } from "../core/runtime.ts";

export interface RenderAssets {
  wasm: WebAssembly.Module | BufferSource;
  fonts: Uint8Array[];
}

let ready: Promise<void> | undefined;

export function createResvgRenderer(loadAssets: () => Promise<RenderAssets>): ChartRenderer {
  let assets: Promise<RenderAssets> | undefined;
  function load(): Promise<RenderAssets> {
    assets ??= loadAssets().then(async (loaded) => {
      ready ??= initWasm(loaded.wasm).catch((err) => {
        ready = undefined;
        throw err;
      });
      await ready;
      return loaded;
    }).catch((err) => {
      assets = undefined;
      throw err;
    });
    return assets;
  }

  return async (svg, width = CHART_WIDTH) => {
    const { fonts } = await load();
    const resvg = new Resvg(svg, {
      fitTo: { mode: "width", value: width },
      font: {
        fontBuffers: fonts,
        defaultFontFamily: FONT_FAMILY,
        loadSystemFonts: false,
      },
    });
    try {
      const image = resvg.render();
      try {
        return image.asPng();
      } finally {
        image.free();
      }
    } finally {
      resvg.free();
    }
  };
}
