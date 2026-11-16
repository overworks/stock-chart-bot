import { createResvgRenderer } from "../../../src/rendering/resvg.ts";

export const renderPng = createResvgRenderer(async () => {
  const [wasm, regular, bold] = await Promise.all([
    Deno.readFile(new URL("./_assets/resvg.wasm", import.meta.url)),
    Deno.readFile(new URL("./_assets/NanumSquareR.ttf", import.meta.url)),
    Deno.readFile(new URL("./_assets/NanumSquareB.ttf", import.meta.url)),
  ]);
  return { wasm, fonts: [regular, bold] };
});
