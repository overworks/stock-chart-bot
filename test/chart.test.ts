import { describe, expect, it } from "vitest";
import { buildSvg, COLOR, FONT_FAMILY, fmtPrice, summarizeChange } from "../src/core/chart";
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

describe("summarizeChange", () => {
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
  it("drops decimals for large non-KRW values", () => {
    expect(fmtPrice(12345.678, "USD")).toBe("12,346");
    expect(fmtPrice(0.1234, "USD")).toBe("0.12");
    expect(fmtPrice(1234.5, "KRW")).toBe("1,235");
  });
});
