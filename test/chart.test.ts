import { describe, expect, it } from "vitest";
import { buildSvg, FONT_FAMILY } from "../src/core/chart";
import type { ChartBar } from "../src/core/types";

const DAY = 86_400;
const daily = (n: number, start = 1_700_000_000): ChartBar[] =>
  Array.from({ length: n }, (_, i) => ({ t: start + i * DAY, c: 100 + i }));

describe("buildSvg", () => {
  it("produces an svg with title, font family, and path", () => {
    const svg = buildSvg(daily(10), "AAPL (1y)");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain(`font-family="${FONT_FAMILY}"`);
    expect(svg).toContain(">AAPL (1y)<");
    expect(svg).toContain('<path d="M');
  });

  it("escapes xml in the title", () => {
    const svg = buildSvg(daily(3), `<b>&"x"</b>`);
    expect(svg).toContain("&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
    expect(svg).not.toContain("<b>");
  });

  it("labels daily charts with dates in the exchange time zone", () => {
    const bars = daily(3, Date.UTC(2024, 0, 1, 23, 0) / 1000);
    const svg = buildSvg(bars, "t", "Asia/Seoul");
    expect(svg).toContain(">2024-01-02<");
    expect(svg).toContain(">2024-01-04<");
    expect(svg).not.toMatch(/\d{2}:\d{2}</);
  });

  it("labels intraday charts with times", () => {
    const start = Date.UTC(2024, 0, 2, 14, 30) / 1000;
    const bars = Array.from({ length: 5 }, (_, i) => ({ t: start + i * 1800, c: 10 + i }));
    const svg = buildSvg(bars, "t", "America/New_York");
    expect(svg).toContain(">2024-01-02 09:30<");
    expect(svg).toContain(">2024-01-02 11:30<");
  });

  it("handles a flat series without NaN coordinates", () => {
    const bars = daily(4).map((b) => ({ ...b, c: 50 }));
    const svg = buildSvg(bars, "flat");
    expect(svg).not.toContain("NaN");
  });
});
