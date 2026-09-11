import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "../../wasm/resvg.wasm";
import fontRegular from "../../fonts/NanumSquareR.ttf";
import fontBold from "../../fonts/NanumSquareB.ttf";
import { FONT_FAMILY } from "./chart";

let ready: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!ready) ready = initWasm(wasm);
  return ready;
}

export async function svgToPng(svg: string, width = 900): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font: {
      fontBuffers: [new Uint8Array(fontRegular), new Uint8Array(fontBold)],
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
}
