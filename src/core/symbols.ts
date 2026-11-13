import { searchRemote, type Providers, type SymbolChoice } from "./market";
import type { SymbolEntry, SymbolReader } from "./storage";

export type { SymbolChoice };
export type { SymbolEntry } from "./storage";
const CACHE_TTL_MS = 10 * 60_000;
const MAX = 25;

interface Loaded {
  entries: SymbolEntry[];
  byKey: Map<string, string>;
  byValue: Map<string, string>;
}

interface CachedSymbols {
  promise: Promise<Loaded>;
  expiresAt: number;
}

let cache = new WeakMap<SymbolReader, CachedSymbols>();

export function resetSymbolCache(store?: SymbolReader): void {
  if (store) cache.delete(store);
  else cache = new WeakMap();
}

/** Yahoo 심볼 형식(005930.KS, KRW=X, BTC-USD, ^KS11)이면 별칭 매핑을 건너뛴다. */
export function looksLikeSymbol(s: string): boolean {
  return /^\^?[A-Z0-9][A-Z0-9.=-]*$/.test(s) && /[.=^-]/.test(s);
}

export function isAsciiQuery(q: string): boolean {
  return /^[\x20-\x7e]+$/.test(q);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

const CHOSUNG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const HANGUL_BASE = 0xac00;
const PER_CHOSUNG = 21 * 28;

function hasJamo(q: string): boolean {
  return /[ㄱ-ㅎ]/.test(q);
}

// "ㅅㅅ전자" → /[가-깋][싸-앃]전자/ 처럼, 초성 글자는 해당 초성으로 시작하는 음절 범위로 바꾼다.
function jamoPattern(q: string): RegExp | null {
  let src = "";
  for (const ch of q) {
    const idx = CHOSUNG.indexOf(ch);
    if (idx >= 0) {
      const from = String.fromCharCode(HANGUL_BASE + idx * PER_CHOSUNG);
      const to = String.fromCharCode(HANGUL_BASE + (idx + 1) * PER_CHOSUNG - 1);
      src += `[${from}-${to}${ch}]`;
    } else {
      src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

export async function loadSymbols(store: SymbolReader): Promise<Loaded> {
  const cached = cache.get(store);
  if (cached && Date.now() < cached.expiresAt) return cached.promise;
  const promise = (async () => {
    const [base, user] = await Promise.all([
      store.readSeed(),
      store.readAliases(),
    ]);
    const entries = [...base, ...user.map((e) => ({ ...e, alias: true }))];
    const byKey = new Map<string, string>();
    const byValue = new Map<string, string>();
    for (const e of entries) {
      if (!byKey.has(e.key)) byKey.set(e.key, e.value);
      if (!e.alias && !byValue.has(e.value)) byValue.set(e.value, e.key);
    }
    // 정식명이 없는 심볼은 첫 별칭을 표시명으로 쓴다.
    for (const e of entries) if (!byValue.has(e.value)) byValue.set(e.value, e.key);
    return { entries, byKey, byValue };
  })();
  const entry = { promise, expiresAt: Infinity };
  cache.set(store, entry);
  try {
    const loaded = await promise;
    entry.expiresAt = Date.now() + CACHE_TTL_MS;
    return loaded;
  } catch (err) {
    if (cache.get(store) === entry) cache.delete(store);
    throw err;
  }
}

export async function symbolName(symbol: string, store: SymbolReader): Promise<string | undefined> {
  const { byValue } = await loadSymbols(store);
  return byValue.get(symbol);
}

/** 별칭은 정확히 일치할 때만 적용한다. 심볼 형식 입력은 그대로 둔다. */
export async function resolveSymbol(ticker: string, store: SymbolReader): Promise<string> {
  const t = ticker.trim();
  if (looksLikeSymbol(t)) return t;
  const { byKey } = await loadSymbols(store);
  return byKey.get(t) ?? t;
}

export async function searchSymbols(query: string, store: SymbolReader, providers: Providers): Promise<SymbolChoice[]> {
  const q = norm(query);
  if (!q) return [];

  const { entries, byValue } = await loadSymbols(store);
  const jamo = hasJamo(q) ? jamoPattern(q) : null;
  const ranked: { score: number; e: SymbolEntry }[] = [];
  for (const e of entries) {
    const k = norm(e.key);
    const v = norm(e.value);
    let score: number;
    if (jamo) {
      const m = jamo.exec(k);
      if (!m) continue;
      score = m.index === 0 ? (m[0].length === k.length ? 0 : 1) : 2;
    } else if (k === q || v === q) score = 0;
    else if (k.startsWith(q) || v.startsWith(q)) score = 1;
    else if (k.includes(q)) score = 2;
    else continue;
    ranked.push({ score, e });
  }
  ranked.sort((a, b) => a.score - b.score || a.e.key.length - b.e.key.length || a.e.key.localeCompare(b.e.key, "ko"));

  const seen = new Set<string>();
  const out: SymbolChoice[] = [];
  const push = (c: SymbolChoice) => {
    if (out.length < MAX && !seen.has(c.value)) {
      seen.add(c.value);
      out.push(c);
    }
  };
  for (const { e } of ranked) push({ name: `${byValue.get(e.value) ?? e.key} (${e.value})`, value: e.value });

  if (out.length < MAX && isAsciiQuery(query.trim()) && q.length >= 2) {
    for (const c of await searchRemote(query.trim(), providers)) push(c);
  }
  return out;
}
