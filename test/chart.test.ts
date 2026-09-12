import { describe, expect, it } from "vitest";
import { buildSvg, COLOR, FONT_FAMILY, fmtPrice, movingAverage, summarizeChange } from "../src/core/chart";
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
    const svg = buildSvg(bars, "t", { timeZone: "Asia/Seoul" });
    expect(svg).toContain(">2024-01-02<");
    expect(svg).toContain(">2024-01-04<");
    expect(svg).not.toMatch(/\d{2}:\d{2}</);
  });

  it("labels intraday charts with times", () => {
    const start = Date.UTC(2024, 0, 2, 14, 30) / 1000;
    const bars = Array.from({ length: 5 }, (_, i) => ({ t: start + i * 1800, c: 10 + i }));
    const svg = buildSvg(bars, "t", { timeZone: "America/New_York" });
    expect(svg).toContain(">2024-01-02 09:30<");
    expect(svg).toContain(">2024-01-02 11:30<");
  });

  it("handles a flat series without NaN coordinates and uses the neutral color", () => {
    const bars = daily(4).map((b) => ({ ...b, c: 50 }));
    const svg = buildSvg(bars, "flat");
    expect(svg).not.toContain("NaN");
    expect(svg).toContain(`stroke="${COLOR.flat}"`);
  });

  it("colors rising series red and falling series blue, and shows the last price", () => {
    const up = buildSvg(daily(5), "up", { currency: "KRW" });
    expect(up).toContain(`stroke="${COLOR.up}"`);
    expect(up).toContain(">104<");
    expect(up).toContain("+4 (+4.00%)");
    const down = buildSvg(daily(5).map((b, i) => ({ t: b.t, c: 104 - i })), "down", { currency: "USD" });
    expect(down).toContain(`stroke="${COLOR.down}"`);
    expect(down).toContain(">100.00<");
    expect(down).toContain("-4.00 (-3.85%)");
  });
});

describe("buildSvg candle + volume", () => {
  const ohlc = (n: number): ChartBar[] =>
    Array.from({ length: n }, (_, i) => ({
      t: 1_700_000_000 + i * DAY,
      o: 100 + i,
      c: i % 2 === 0 ? 102 + i : 99 + i,
      h: 104 + i,
      l: 97 + i,
      v: 1000 * (i + 1),
    }));

  it("draws one wick and body per bar, colored by open/close", () => {
    const svg = buildSvg(ohlc(6), "c", { style: "candle" });
    expect((svg.match(/<rect /g) ?? []).length).toBe(1 + 6 + 6);
    const wicks = (svg.match(/<line [^>]*stroke="#(dc2626|2563eb|6b7280)"/g) ?? []).length;
    expect(wicks).toBe(6);
    expect(svg).toContain(`fill="${COLOR.up}"`);
    expect(svg).toContain(`fill="${COLOR.down}"`);
    expect(svg).not.toContain("<path d=\"M");
  });

  it("scales the price axis to high/low in candle mode", () => {
    const svg = buildSvg(ohlc(3), "c", { style: "candle", currency: "KRW" });
    expect(svg).toContain(">106<");
    expect(svg).toContain(">97<");
  });

  it("adds a volume panel only when volume data exists", () => {
    expect(buildSvg(ohlc(4), "v")).toContain(">4K<");
    expect(buildSvg(daily(4), "v")).not.toContain("fill-opacity=\"0.45\"");
  });

  it("falls back to close when open/high/low are missing", () => {
    const svg = buildSvg(daily(5), "c", { style: "candle" });
    expect(svg).not.toContain("NaN");
    expect((svg.match(/<rect /g) ?? []).length).toBe(1 + 5);
  });
});

describe("moving averages", () => {
  it("computes a simple moving average with leading gaps", () => {
    const bars = [1, 2, 3, 4, 5].map((c, i) => ({ t: i, c }));
    expect(movingAverage(bars, 3)).toEqual([undefined, undefined, 2, 3, 4]);
  });

  it("draws MA20/MA60 only when enough bars exist", () => {
    expect(buildSvg(daily(10), "s")).not.toContain("MA20");
    const mid = buildSvg(daily(30), "s");
    expect(mid).toContain(">MA20<");
    expect(mid).not.toContain("MA60");
    const long = buildSvg(daily(80), "s", { style: "candle" });
    expect(long).toContain(">MA20<");
    expect(long).toContain(">MA60<");
    expect((long.match(/stroke="#f59e0b"/g) ?? []).length).toBe(1);
  });

  it("skips moving averages on intraday charts", () => {
    const bars = Array.from({ length: 80 }, (_, i) => ({ t: 1_700_000_000 + i * 300, c: 10 + (i % 7) }));
    expect(buildSvg(bars, "i")).not.toContain("MA20");
  });

  it("trusts an explicit intraday flag over the timestamp heuristic", () => {
    const thirtyMin = Array.from({ length: 80 }, (_, i) => ({ t: 1_700_000_000 + i * 1800, c: 10 + (i % 7) }));
    expect(buildSvg(thirtyMin, "i", { intraday: false })).toContain("MA20");
    expect(buildSvg(daily(80), "d", { intraday: true })).not.toContain("MA20");
    expect(buildSvg(daily(3), "d", { intraday: true, timeZone: "UTC" })).toMatch(/\d{2}:\d{2}</);
  });

  it("refuses to draw fewer than two bars", () => {
    expect(() => buildSvg(daily(1), "x")).toThrow("부족");
  });
});

describe("summarizeChange", () => {
  it("uses the reference price instead of the first bar when given", () => {
    const s = summarizeChange([{ t: 1, c: 100 }, { t: 2, c: 99 }], "USD", 110);
    expect(s.text).toBe("99.00 USD ▼ -11.00 (-10.00%)");
  });

  it("draws a dashed previous-close line with a label and widens the axis to include it", () => {
    const bars = [{ t: 1, c: 100 }, { t: 2, c: 101 }, { t: 3, c: 102 }];
    const svg = buildSvg(bars, "T", { reference: 110, currency: "KRW" });
    expect(svg).toContain('stroke-dasharray="4 3"');
    expect(svg).toContain("전일 종가 110");
    expect(svg).toContain(">110<");
    expect(svg).toContain(">100<");
    const without = buildSvg(bars, "T", { currency: "KRW" });
    expect(without).not.toContain("stroke-dasharray");
    expect(without).not.toContain("전일 종가");
  });

  it("formats KRW without decimals and with thousands separators", () => {
    const s = summarizeChange([{ t: 1, c: 269_000 }, { t: 2, c: 258_500 }], "KRW");
    expect(s.direction).toBe("down");
    expect(s.text).toBe("258,500 KRW ▼ -10,500 (-3.90%)");
  });

  it("formats USD with two decimals and a plus sign when rising", () => {
    const s = summarizeChange([{ t: 1, c: 100 }, { t: 2, c: 101.5 }], "USD");
    expect(s.direction).toBe("up");
    expect(s.text).toBe("101.50 USD ▲ +1.50 (+1.50%)");
  });

  it("omits the currency suffix when unknown", () => {
    expect(summarizeChange([{ t: 1, c: 2 }, { t: 2, c: 2 }]).text).toBe("2.00 - 0.00 (0.00%)");
  });
});

describe("fmtPrice", () => {
  it("drops decimals for large values and for integer or 1,000+ KRW amounts", () => {
    expect(fmtPrice(12345.678, "USD")).toBe("12,346");
    expect(fmtPrice(0.1234, "USD")).toBe("0.1234");
    expect(fmtPrice(0.00123456, "KRW")).toBe("0.001235");
    expect(fmtPrice(1234.5, "KRW")).toBe("1,234.50");
    expect(fmtPrice(1345.14, "KRW")).toBe("1,345.14");
    expect(fmtPrice(259500, "KRW")).toBe("259,500");
    expect(fmtPrice(800, "KRW")).toBe("800");
    expect(fmtPrice(8.697, "KRW")).toBe("8.70");
    expect(fmtPrice(-4.01, "KRW")).toBe("-4.01");
  });
});

describe("source footer", () => {
  it("prints the provider and generation time in the chart time zone", () => {
    const now = new Date(Date.UTC(2026, 8, 11, 6, 30));
    const svg = buildSvg(daily(5), "s", { source: "Yahoo Finance", timeZone: "America/New_York", now });
    expect(svg).toContain(">Yahoo Finance · 2026-09-11 15:30 KST<");
    expect(buildSvg(daily(5), "s")).not.toContain("Yahoo Finance");
  });
});
