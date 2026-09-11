import type { ChartBar } from "./types";

export const FONT_FAMILY = "NanumSquare";

export const COLOR = {
  up: "#dc2626",
  down: "#2563eb",
  flat: "#6b7280",
} as const;

export interface ChartOptions {
  timeZone?: string;
  currency?: string;
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
const H = 500;
const PAD = { l: 72, r: 24, t: 80, b: 44 };

export function summarizeChange(bars: ChartBar[], currency = ""): ChangeSummary {
  const first = bars[0].c;
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
  const { timeZone = "UTC", currency = "" } = opts;
  const closes = bars.map((b) => b.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const change = summarizeChange(bars, currency);

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (i / (bars.length - 1)) * plotW;
  const y = (c: number) => PAD.t + (1 - (c - min) / span) * plotH;

  const line = bars.map((b, i) => `${i === 0 ? "M" : "L"}${fmt(x(i))},${fmt(y(b.c))}`).join(" ");
  const area = `${line} L${fmt(x(bars.length - 1))},${PAD.t + plotH} L${fmt(x(0))},${PAD.t + plotH} Z`;

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

  const intraday = bars[1].t - bars[0].t < 86_400;
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
  <path d="${area}" fill="${change.color}" fill-opacity="0.10"/>
  <path d="${line}" fill="none" stroke="${change.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
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
