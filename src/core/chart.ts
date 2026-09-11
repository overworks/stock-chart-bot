import type { ChartBar, ChartStyle } from "./types";

export const FONT_FAMILY = "NanumSquare";

export const COLOR = {
  up: "#dc2626",
  down: "#2563eb",
  flat: "#6b7280",
} as const;

export const MA_PERIODS = [20, 60] as const;
const MA_COLOR: Record<number, string> = { 20: "#f59e0b", 60: "#8b5cf6" };

export interface ChartOptions {
  timeZone?: string;
  currency?: string;
  style?: ChartStyle;
  /** 등락 계산 기준가. 없으면 첫 봉 종가. 1d 차트에서는 전일 종가를 넘긴다. */
  reference?: number;
}

export interface ChangeSummary {
  first: number;
  last: number;
  diff: number;
  pct: number;
  direction: "up" | "down" | "flat";
  color: string;
  text: string;
}

const W = 900;
const H = 560;
const PAD = { l: 72, r: 24, t: 80, b: 44 };
const VOL_H = 80;
const VOL_GAP = 12;

export function summarizeChange(bars: ChartBar[], currency = "", reference?: number): ChangeSummary {
  const first = reference ?? bars[0].c;
  const last = bars[bars.length - 1].c;
  const diff = last - first;
  const pct = first === 0 ? 0 : (diff / first) * 100;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "-";
  const sign = diff > 0 ? "+" : "";
  const text = `${fmtPrice(last, currency)}${currency ? ` ${currency}` : ""} ${arrow} ${sign}${fmtPrice(diff, currency)} (${sign}${pct.toFixed(2)}%)`;
  return { first, last, diff, pct, direction, color: COLOR[direction], text };
}

export function buildSvg(bars: ChartBar[], title: string, opts: ChartOptions = {}): string {
  const { timeZone = "UTC", currency = "", style = "line", reference } = opts;
  const candle = style === "candle";
  const hasVolume = bars.some((b) => (b.v ?? 0) > 0);
  const change = summarizeChange(bars, currency, reference);

  const lows = candle ? bars.map((b) => b.l ?? b.c) : bars.map((b) => b.c);
  const highs = candle ? bars.map((b) => b.h ?? b.c) : bars.map((b) => b.c);
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;

  const plotW = W - PAD.l - PAD.r;
  const volH = hasVolume ? VOL_H : 0;
  const plotH = H - PAD.t - PAD.b - (hasVolume ? volH + VOL_GAP : 0);
  const volTop = PAD.t + plotH + VOL_GAP;
  const slot = plotW / Math.max(bars.length, 1);
  const x = candle
    ? (i: number) => PAD.l + (i + 0.5) * slot
    : (i: number) => PAD.l + (i / (bars.length - 1)) * plotW;
  const y = (c: number) => PAD.t + (1 - (c - min) / span) * plotH;

  const line = bars.map((b, i) => `${i === 0 ? "M" : "L"}${fmt(x(i))},${fmt(y(b.c))}`).join(" ");
  const area = `${line} L${fmt(x(bars.length - 1))},${PAD.t + plotH} L${fmt(x(0))},${PAD.t + plotH} Z`;

  const bodyW = Math.max(1, Math.min(12, slot * 0.7));
  const candles = candle
    ? bars
        .map((b, i) => {
          const o = b.o ?? b.c;
          const h = b.h ?? Math.max(o, b.c);
          const l = b.l ?? Math.min(o, b.c);
          const color = b.c > o ? COLOR.up : b.c < o ? COLOR.down : COLOR.flat;
          const top = y(Math.max(o, b.c));
          const bottom = y(Math.min(o, b.c));
          const cx = x(i);
          return (
            `<line x1="${fmt(cx)}" y1="${fmt(y(h))}" x2="${fmt(cx)}" y2="${fmt(y(l))}" stroke="${color}" stroke-width="1"/>` +
            `<rect x="${fmt(cx - bodyW / 2)}" y="${fmt(top)}" width="${fmt(bodyW)}" height="${fmt(Math.max(1, bottom - top))}" fill="${color}"/>`
          );
        })
        .join("")
    : "";

  const intraday = bars[1].t - bars[0].t < 86_400;
  const mas = intraday ? [] : MA_PERIODS.filter((p) => bars.length > p).map((p) => ({ p, values: movingAverage(bars, p) }));
  const maLines = mas
    .map(({ p, values }) => {
      const d = values
        .map((v, i) => (v === undefined ? "" : `${fmt(x(i))},${fmt(y(v))}`))
        .filter(Boolean)
        .map((pt, i) => `${i === 0 ? "M" : "L"}${pt}`)
        .join(" ");
      return `<path d="${d}" fill="none" stroke="${MA_COLOR[p]}" stroke-width="1.5" stroke-linejoin="round" stroke-opacity="0.9"/>`;
    })
    .join("");
  const maLegend = mas
    .map(({ p }, i) => `<text x="${PAD.l + i * 62}" y="${PAD.t - 8}" font-size="12" fill="${MA_COLOR[p]}">MA${p}</text>`)
    .join("");

  const maxVol = hasVolume ? Math.max(...bars.map((b) => b.v ?? 0)) || 1 : 1;
  const volW = Math.max(1, Math.min(12, slot * 0.7));
  const volumes = hasVolume
    ? bars
        .map((b, i) => {
          const v = b.v ?? 0;
          if (v <= 0) return "";
          const prev = i > 0 ? bars[i - 1].c : (b.o ?? b.c);
          const color = b.c > prev ? COLOR.up : b.c < prev ? COLOR.down : COLOR.flat;
          const hgt = (v / maxVol) * volH;
          const cx = x(i);
          return `<rect x="${fmt(cx - volW / 2)}" y="${fmt(volTop + volH - hgt)}" width="${fmt(volW)}" height="${fmt(hgt)}" fill="${color}" fill-opacity="0.45"/>`;
        })
        .join("") +
      `<line x1="${PAD.l}" y1="${fmt(volTop + volH)}" x2="${W - PAD.r}" y2="${fmt(volTop + volH)}" stroke="#e5e7eb" stroke-width="1"/>` +
      `<text x="${PAD.l - 10}" y="${fmt(volTop + 12)}" text-anchor="end" font-size="11" fill="#9ca3af">${fmtVolume(maxVol)}</text>`
    : "";

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((r) => {
      const gy = PAD.t + r * plotH;
      const price = max - r * span;
      return (
        `<line x1="${PAD.l}" y1="${fmt(gy)}" x2="${W - PAD.r}" y2="${fmt(gy)}" ` +
        `stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${PAD.l - 10}" y="${fmt(gy + 4)}" text-anchor="end" ` +
        `font-size="12" fill="#6b7280">${fmtPrice(price, currency)}</text>`
      );
    })
    .join("");

  const fmtDate = dateFormatter(timeZone, intraday);
  const xLabels = [0, Math.floor((bars.length - 1) / 2), bars.length - 1]
    .map((i) => {
      const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
      return (
        `<text x="${fmt(x(i))}" y="${H - PAD.b + 22}" text-anchor="${anchor}" ` +
        `font-size="12" fill="#6b7280">${fmtDate(bars[i].t)}</text>`
      );
    })
    .join("");

  const sign = change.diff > 0 ? "+" : "";
  const subtitle =
    `${fmtDate(bars[0].t)} ~ ${fmtDate(bars[bars.length - 1].t)}` +
    `  ·  ${sign}${fmtPrice(change.diff, currency)} (${sign}${change.pct.toFixed(2)}%)`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${PAD.l}" y="34" font-size="22" font-weight="700" fill="#111827">${escapeXml(title)}</text>
  <text x="${PAD.l}" y="58" font-size="14" fill="${change.color}">${escapeXml(subtitle)}</text>
  <text x="${W - PAD.r}" y="34" text-anchor="end" font-size="26" font-weight="700" fill="${change.color}">${escapeXml(fmtPrice(change.last, currency))}</text>
  <text x="${W - PAD.r}" y="58" text-anchor="end" font-size="14" fill="#6b7280">${escapeXml(currency)}</text>
  ${gridLines}
  ${candle ? candles : `<path d="${area}" fill="${change.color}" fill-opacity="0.10"/>
  <path d="${line}" fill="none" stroke="${change.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`}
  ${maLines}
  ${maLegend}
  ${volumes}
  ${xLabels}
</svg>`;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "0";
}

const ZERO_DECIMAL = new Set(["KRW", "JPY", "IDR", "VND", "HUF", "CLP"]);

export function fmtPrice(n: number, currency = ""): string {
  const digits = ZERO_DECIMAL.has(currency) ? 0 : Math.abs(n) >= 10_000 ? 0 : 2;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

export function movingAverage(bars: ChartBar[], period: number): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(bars.length).fill(undefined);
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].c;
    if (i >= period) sum -= bars[i - period].c;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function fmtVolume(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return String(Math.round(v));
}

function dateFormatter(timeZone: string, intraday: boolean): (epochSec: number) => string {
  const f = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(intraday ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
  return (epochSec) => f.format(new Date(epochSec * 1000));
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}
