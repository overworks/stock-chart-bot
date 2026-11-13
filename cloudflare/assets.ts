import wasm from "../wasm/resvg.wasm";
import fontRegular from "../fonts/NanumSquareR.ttf";
import fontBold from "../fonts/NanumSquareB.ttf";
import { createResvgRenderer } from "../src/rendering/resvg";

export const renderPng = createResvgRenderer(async () => ({
  wasm,
  fonts: [new Uint8Array(fontRegular), new Uint8Array(fontBold)],
}));
