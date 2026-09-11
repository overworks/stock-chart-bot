import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasm from "../../wasm/resvg.wasm";

let ready: Promise<void> | null = null;

function ensureWasm(): Promise<void> {
  if (!ready) ready = initWasm(wasm);
  return ready;
}

export async function svgToPng(svg: string, width = 900): Promise<Uint8Array> {
  await ensureWasm();
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  return resvg.render().asPng();
}
