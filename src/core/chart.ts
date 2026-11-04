import type { ChartBar, ChartStyle, TimeSpan } from "./types";

export const FONT_FAMILY = "NanumSquare";
/** 번들 굵은 폰트는 패밀리명이 'NanumSquare Bold'로 등록돼 있어 font-weight가 아닌 패밀리로 지정해야 한다. */
export const FONT_BOLD = "NanumSquare Bold";

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
  source?: string;
  now?: Date;
  /** 분·시간봉 여부. 없으면 봉 간격으로 추정한다. */
  intraday?: boolean;
  /** 하단 거래량 막대. 기본은 그리지 않는다. */
  volume?: boolean;
  /** 정규장 구간. 주어지면 그 밖의 봉 구간에 프리마켓·애프터마켓 음영을 넣는다. */
  regularHours?: TimeSpan[];
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

// 논리 좌표 600×448을 900px 폭으로 렌더링한다(1.5배). 축소 표시되는 메신저에서도 읽히도록 글자를 크게 잡는다.
const W = 600;
const H = 448;
const M = 24;
const PAD = { r: M, t: 142, b: 70 };
const LABEL_GAP = 10;
const FS = { title: 30, price: 36, change: 20, unit: 19, axis: 17, legend: 16, note: 15 } as const;
const GRID = [0, 0.25, 0.5, 0.75, 1];
const VOL_H = 56;
const VOL_GAP = 12;
const BAR_MAX = 8;
const PLOT_FILL = "#f6f7f9";
const EXT_FILL = "#e9ebef";
const AXIS_COLOR = "#4b5563";
const NOTE_COLOR = "#6b7280";

export function summarizeChange(bars: ChartBar[], currency = "", reference?: number): ChangeSummary {
  const first = reference ?? bars[0].c;
  const last = bars[bars.length - 1].c;
  const diff = last - first;
  const pct = first === 0 ? 0 : (diff / first) * 100;
  const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
  const text = `${fmtPrice(last, currency)}${currency ? ` ${currency}` : ""} ${changeText(diff, pct, currency)}`;
  return { first, last, diff, pct, direction, color: COLOR[direction], text };
}

function changeText(diff: number, pct: number, currency: string): string {
  const arrow = diff > 0 ? "▲" : diff < 0 ? "▼" : "-";
  const sign = diff > 0 ? "+" : "";
  return `${arrow} ${sign}${fmtPrice(diff, currency)} (${sign}${pct.toFixed(2)}%)`;
}

export function buildSvg(bars: ChartBar[], title: string, opts: ChartOptions = {}): string {
  const { timeZone = "UTC", currency = "", style = "line", reference, source, now = new Date() } = opts;
  if (bars.length < 2) throw new Error("차트를 그리기에 데이터가 부족합니다.");
  const candle = style === "candle";
  const hasVolume = !!opts.volume && bars.some((b) => (b.v ?? 0) > 0);
  const change = summarizeChange(bars, currency, reference);

  const lows = candle ? bars.map((b) => b.l ?? b.c) : bars.map((b) => b.c);
  const highs = candle ? bars.map((b) => b.h ?? b.c) : bars.map((b) => b.c);
  // 기준가(전일 종가)가 있으면 눈금 범위에 넣어 기준선이 항상 보이게 한다.
  const min = Math.min(...lows, reference ?? Infinity);
  const max = Math.max(...highs, reference ?? -Infinity);
  const span = max - min || 1;
  const allInt = bars.every((b) => Number.isInteger(b.c));
  const yLabels = GRID.map((r) => {
    const raw = max - r * span;
    return fmtPrice(allInt ? Math.round(raw) : raw, currency);
  });
  // 1억 단위 원화(KRW-BTC)처럼 긴 눈금 라벨이 잘리지 않게 왼쪽 여백을 라벨 길이에 맞춘다.
  const pad = { ...PAD, l: Math.ceil(M + LABEL_GAP + Math.max(...yLabels.map((s) => textWidth(s, FS.axis)))) };

  const plotW = W - pad.l - pad.r;
  const volH = hasVolume ? VOL_H : 0;
  const plotH = H - pad.t - pad.b - (hasVolume ? volH + VOL_GAP : 0);
  const volTop = pad.t + plotH + VOL_GAP;
  const slot = plotW / Math.max(bars.length, 1);
  const x = candle
    ? (i: number) => pad.l + (i + 0.5) * slot
    : (i: number) => pad.l + (i / (bars.length - 1)) * plotW;
  const y = (c: number) => pad.t + (1 - (c - min) / span) * plotH;

  const line = bars.map((b, i) => `${i === 0 ? "M" : "L"}${fmt(x(i))},${fmt(y(b.c))}`).join(" ");
  const area = `${line} L${fmt(x(bars.length - 1))},${pad.t + plotH} L${fmt(x(0))},${pad.t + plotH} Z`;

  const barW = Math.max(1, Math.min(BAR_MAX, slot * 0.7));
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
            `<rect x="${fmt(cx - barW / 2)}" y="${fmt(top)}" width="${fmt(barW)}" height="${fmt(Math.max(1, bottom - top))}" fill="${color}"/>`
          );
        })
        .join("")
    : "";

  const intraday = opts.intraday ?? bars[1].t - bars[0].t < 86_400;
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
    .map(({ p }, i) => {
      const lx = M + i * 80;
      return (
        `<rect x="${lx}" y="${H - 31}" width="14" height="3" fill="${MA_COLOR[p]}"/>` +
        `<text x="${lx + 19}" y="${H - 24}" font-size="${FS.legend}" font-family="${FONT_BOLD}" fill="${MA_COLOR[p]}">MA${p}</text>`
      );
    })
    .join("");

  const maxVol = hasVolume ? Math.max(...bars.map((b) => b.v ?? 0)) || 1 : 1;
  const volumes = hasVolume
    ? bars
        .map((b, i) => {
          const v = b.v ?? 0;
          if (v <= 0) return "";
          const prev = i > 0 ? bars[i - 1].c : (b.o ?? b.c);
          const color = b.c > prev ? COLOR.up : b.c < prev ? COLOR.down : COLOR.flat;
          const hgt = (v / maxVol) * volH;
          const cx = x(i);
          return `<rect x="${fmt(cx - barW / 2)}" y="${fmt(volTop + volH - hgt)}" width="${fmt(barW)}" height="${fmt(hgt)}" fill="${color}" fill-opacity="0.45"/>`;
        })
        .join("") +
      `<line x1="${pad.l}" y1="${fmt(volTop + volH)}" x2="${W - pad.r}" y2="${fmt(volTop + volH)}" stroke="#e5e7eb" stroke-width="1"/>` +
      `<text x="${pad.l - LABEL_GAP}" y="${fmt(volTop + 13)}" text-anchor="end" font-size="${FS.note}" fill="${NOTE_COLOR}">${fmtVolume(maxVol)}</text>`
    : "";

  const gridLines = GRID
    .map((r, i) => {
      const gy = pad.t + r * plotH;
      return (
        `<line x1="${pad.l}" y1="${fmt(gy)}" x2="${W - pad.r}" y2="${fmt(gy)}" ` +
        `stroke="#e5e7eb" stroke-width="1"/>` +
        `<text x="${pad.l - LABEL_GAP}" y="${fmt(gy + 6)}" text-anchor="end" ` +
        `font-size="${FS.axis}" fill="${AXIS_COLOR}">${yLabels[i]}</text>`
      );
    })
    .join("");

  const fmtDate = dateFormatter(timeZone, intraday);
  const xLabels = [0, Math.floor((bars.length - 1) / 2), bars.length - 1]
    .map((i) => {
      const anchor = i === 0 ? "start" : i === bars.length - 1 ? "end" : "middle";
      return (
        `<text x="${fmt(x(i))}" y="${H - pad.b + 22}" text-anchor="${anchor}" ` +
        `font-size="${FS.axis}" fill="${AXIS_COLOR}">${fmtDate(bars[i].t)}</text>`
      );
    })
    .join("");

  // 봉 i-1과 i 사이 경계. 0과 n은 플롯 양끝.
  const edge = (i: number) => (i <= 0 ? pad.l : i >= bars.length ? W - pad.r : (x(i - 1) + x(i)) / 2);
  const runs = extendedRuns(bars, opts.regularHours);
  const shadeBottom = hasVolume ? volTop + volH : pad.t + plotH;
  const extShade = runs
    .map(({ from, to }) => `<rect x="${fmt(edge(from))}" y="${pad.t}" width="${fmt(edge(to + 1) - edge(from))}" height="${fmt(shadeBottom - pad.t)}" fill="${EXT_FILL}"/>`)
    .join("");
  const plotFill = `<rect x="${pad.l}" y="${pad.t}" width="${fmt(plotW)}" height="${fmt(shadeBottom - pad.t)}" fill="${PLOT_FILL}"/>`;
  const extLabels = runs
    .filter(({ from, to, label }) => edge(to + 1) - edge(from) >= 12 + textWidth(label, FS.note))
    .map(({ from, label }) => `<text x="${fmt(edge(from) + 6)}" y="${pad.t + 18}" font-size="${FS.note}" fill="${NOTE_COLOR}" stroke="${EXT_FILL}" stroke-width="4" paint-order="stroke">${label}</text>`)
    .join("");

  const referenceLine =
    reference !== undefined
      ? `<line x1="${pad.l}" y1="${fmt(y(reference))}" x2="${W - pad.r}" y2="${fmt(y(reference))}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 3"/>` +
        `<text x="${W - pad.r}" y="${fmt(y(reference) - 6)}" text-anchor="end" font-size="${FS.note}" fill="${NOTE_COLOR}" stroke="${PLOT_FILL}" stroke-width="4" paint-order="stroke">${escapeXml(`전일 종가 ${fmtPrice(reference, currency)}`)}</text>`
      : "";

  const footer = source
    ? `<text x="${W - pad.r}" y="${H - 24}" text-anchor="end" font-size="${FS.note}" fill="${NOTE_COLOR}">${escapeXml(`${source} · ${footerTime(now)}`)}</text>`
    : "";

  const headW = W - 2 * M;
  const heading = fitTitle(title, FS.title, headW);
  const price = fmtPrice(change.last, currency);
  const delta = changeText(change.diff, change.pct, currency);
  // 가격 줄은 한 줄에 두고, 넘치면 세 요소를 같은 비율로 줄인다.
  const priceW =
    textWidth(price, FS.price) + (currency ? 6 + textWidth(currency, FS.unit) : 0) + 14 + textWidth(delta, FS.change);
  const k = Math.min(1, headW / priceW);
  const size = (n: number) => Math.floor(n * k);
  const priceLine =
    `<text x="${M}" y="90" font-family="${FONT_BOLD}" fill="${change.color}">` +
    `<tspan font-size="${size(FS.price)}">${escapeXml(price)}</tspan>` +
    (currency ? `<tspan dx="6" font-size="${size(FS.unit)}" font-family="${FONT_FAMILY}" fill="${NOTE_COLOR}">${escapeXml(currency)}</tspan>` : "") +
    `<tspan dx="14" font-size="${size(FS.change)}">${escapeXml(delta)}</tspan>` +
    `</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  ${plotFill}
  ${extShade}
  <text x="${M}" y="46" font-size="${FS.title}" font-family="${FONT_BOLD}" fill="#111827">${escapeXml(heading)}</text>
  ${priceLine}
  ${gridLines}
  ${candle ? candles : `<path d="${area}" fill="${change.color}" fill-opacity="0.10"/>
  <path d="${line}" fill="none" stroke="${change.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`}
  ${extLabels}
  ${referenceLine}
  ${maLines}
  ${volumes}
  ${xLabels}
  ${maLegend}
  ${footer}
</svg>`;
}

/** 너비를 넘는 제목은 이름 부분을 말줄임하고 "(심볼) · 기간" 꼬리는 남긴다. */
function fitTitle(title: string, size: number, maxW: number): string {
  if (textWidth(title, size) <= maxW) return title;
  const cut = title.indexOf(" (");
  const tail = cut > 0 ? title.slice(cut) : "";
  const head = [...(cut > 0 ? title.slice(0, cut) : title)];
  while (head.length > 1 && textWidth(`${head.join("").trimEnd()}...${tail}`, size) > maxW) head.pop();
  return `${head.join("").trimEnd()}...${tail}`;
}

/** 번들 나눔스퀘어(굵게) 글리프 폭을 근사한 텍스트 폭. 넘치지 않도록 약간 넉넉하게 잡는다. */
export function textWidth(s: string, size: number): number {
  let em = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x1100) em += 0.91;
    else if (c >= 0x30 && c <= 0x39) em += 0.61;
    else if (c >= 0x41 && c <= 0x5a) em += 0.68;
    else if (c >= 0x61 && c <= 0x7a) em += 0.56;
    else if (" .,:;'()[]!|".includes(ch)) em += 0.3;
    else if ("%&@".includes(ch)) em += 0.9;
    else em += 0.5;
  }
  return em * size;
}

/** 정규장 밖의 연속된 봉 구간. 가까운 정규장이 앞이면 애프터마켓, 뒤면 프리마켓이다. */
export function extendedRuns(bars: ChartBar[], regular?: TimeSpan[]): { from: number; to: number; label: string }[] {
  if (!regular?.length) return [];
  const runs: { from: number; to: number; label: string }[] = [];
  bars.forEach(({ t }, i) => {
    if (regular.some((r) => r.start <= t && t <= r.end)) return;
    const sinceClose = t - Math.max(...regular.filter((r) => r.end < t).map((r) => r.end));
    const untilOpen = Math.min(...regular.filter((r) => r.start > t).map((r) => r.start)) - t;
    const label = sinceClose < untilOpen ? "애프터마켓" : "프리마켓";
    const last = runs.at(-1);
    if (last && last.to === i - 1 && last.label === label) last.to = i;
    else runs.push({ from: i, to: i, label });
  });
  return runs;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : "0";
}

const ZERO_DECIMAL = new Set(["KRW", "JPY", "IDR", "VND", "HUF", "CLP"]);

/** 큰 값은 정수, 원·엔 등은 1,000 이상이거나 정수면 소수점 없이, 그 외 소수 둘째 자리. */
export function fmtPrice(n: number, currency = ""): string {
  const abs = Math.abs(n);
  if (abs > 0 && abs < 1) return new Intl.NumberFormat("en-US", { maximumSignificantDigits: 4 }).format(n);
  const zero = abs >= 10_000 || (ZERO_DECIMAL.has(currency) && Number.isInteger(n));
  const digits = zero ? 0 : 2;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
}

function footerTime(d: Date): string {
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${s} KST`;
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
  return (epochSec) => {
    const s = f.format(new Date(epochSec * 1000));
    return intraday ? s.slice(5) : s;
  };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!,
  );
}
