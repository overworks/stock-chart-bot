import { describe, expect, it } from "vitest";
import { displayRule, scaleSeries } from "../src/core/display";

describe("display scaling", () => {
  it("multiplies OHLC and previous close, leaving volume and timestamps alone", () => {
    const s = scaleSeries(
      { bars: [{ t: 1, c: 8.7, o: 8.6, h: 8.8, l: 8.5, v: 10 }, { t: 2, c: 8.71 }], label: "1d", intraday: true, timeZone: "UTC", currency: "KRW", source: "x", previousClose: 8.716 },
      100,
    );
    expect(s.bars[0]).toEqual({ t: 1, c: 870, o: 860, h: 880, l: 850, v: 10 });
    expect(s.bars[1]).toEqual({ t: 2, c: 871, o: undefined, h: undefined, l: undefined });
    expect(s.previousClose).toBeCloseTo(871.6);
  });

  it("only knows JPY/KRW for now", () => {
    expect(displayRule("JPYKRW=X")).toEqual({ factor: 100, label: "100엔" });
    expect(displayRule("KRW=X")).toBeUndefined();
  });
});
