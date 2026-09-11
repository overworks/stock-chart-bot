import { describe, expect, it } from "vitest";
import { parseChartArgs } from "../src/core/command";

describe("parseChartArgs", () => {
  it("defaults range to 1d", () => {
    expect(parseChartArgs({ ticker: "AAPL" })).toEqual({ ticker: "AAPL", range: "1d", style: "line" });
  });

  it("trims ticker and keeps a valid range", () => {
    expect(parseChartArgs({ ticker: " 삼성전자 ", range: "1m" })).toEqual({ ticker: "삼성전자", range: "1m", style: "line" });
  });

  it("falls back to 1d for an unknown range", () => {
    expect(parseChartArgs({ ticker: "AAPL", range: "2w" }).range).toBe("1d");
  });

  it("accepts candle style and falls back to line for unknown styles", () => {
    expect(parseChartArgs({ ticker: "AAPL", style: "candle" }).style).toBe("candle");
    expect(parseChartArgs({ ticker: "AAPL", style: "bars" }).style).toBe("line");
  });

  it("rejects a missing ticker", () => {
    expect(() => parseChartArgs({})).toThrow("종목");
    expect(() => parseChartArgs({ ticker: "  " })).toThrow("종목");
  });

  it("returns a custom period when from/to are both given", () => {
    expect(parseChartArgs({ ticker: "AAPL", from: "2024-01-01", to: "2024-06-30" })).toEqual({
      ticker: "AAPL",
      from: "2024-01-01",
      to: "2024-06-30",
      style: "line",
    });
  });

  it("rejects from without to and vice versa", () => {
    expect(() => parseChartArgs({ ticker: "AAPL", from: "2024-01-01" })).toThrow("함께");
    expect(() => parseChartArgs({ ticker: "AAPL", to: "2024-01-01" })).toThrow("함께");
  });

  it("rejects malformed dates and inverted periods", () => {
    expect(() => parseChartArgs({ ticker: "AAPL", from: "2024/01/01", to: "2024-06-30" })).toThrow("YYYY-MM-DD");
    expect(() => parseChartArgs({ ticker: "AAPL", from: "2024-06-30", to: "2024-01-01" })).toThrow("앞서야");
    expect(() => parseChartArgs({ ticker: "AAPL", from: "2024-01-01", to: "2024-01-01" })).toThrow("앞서야");
  });
});
