import { buildSvg } from "../../../src/core/chart.ts";
import { renderPng } from "../../../supabase/functions/stock-chart-bot/assets.ts";

const bars = Array.from({ length: 2000 }, (_, index) => ({
  t: 1_700_000_000 + index * 86_400,
  o: 100 + index, h: 110 + index, l: 90 + index, c: 105 + index, v: 1000,
}));

for (const style of ["line", "candle"] as const) {
  Deno.test(`renders 2000 Korean ${style} bars with volume using bundled WASM and fonts`, async () => {
    const svg = buildSvg(bars, "긴 한글 종목 (LONG)", {
      style, volume: true, currency: "KRW", timeZone: "Asia/Seoul", now: new Date("2026-11-16T00:00:00Z"),
    });
    const bytes = await renderPng(svg);
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => bytes[index] === value)) throw new Error("PNG 서명이 올바르지 않습니다.");
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (header.getUint32(16) !== 960 || header.getUint32(20) !== 540) throw new Error("PNG 크기가 올바르지 않습니다.");
    if (bytes.length < 1000) throw new Error("PNG 이미지 데이터가 부족합니다.");
  });
}
