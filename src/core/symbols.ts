export interface SymbolChoice {
  name: string;
  value: string;
}

export interface SymbolEntry {
  key: string;
  value: string;
}

export const SYMBOLS_KEY = "symbols:v1";
const CACHE_TTL_MS = 10 * 60_000;
const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const MAX = 25;
const QUOTE_TYPES = new Set(["EQUITY", "ETF", "INDEX", "MUTUALFUND", "CRYPTOCURRENCY", "CURRENCY", "FUTURE"]);

interface Loaded {
  entries: SymbolEntry[];
  byKey: Map<string, string>;
  at: number;
}

let cache: Loaded | null = null;

export function resetSymbolCache(): void {
  cache = null;
}

export function isAsciiQuery(q: string): boolean {
  return /^[\x20-\x7e]+$/.test(q);
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

export async function loadSymbols(kv: KVNamespace): Promise<Loaded> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache;
  const entries = (await kv.get<SymbolEntry[]>(SYMBOLS_KEY, "json")) ?? [];
  const byKey = new Map<string, string>();
  for (const e of entries) byKey.set(norm(e.key), e.value);
  cache = { entries, byKey, at: Date.now() };
  return cache;
}

export async function resolveSymbol(ticker: string, kv: KVNamespace): Promise<string> {
  const { byKey } = await loadSymbols(kv);
  return byKey.get(norm(ticker)) ?? ticker;
}

export async function searchSymbols(query: string, kv: KVNamespace): Promise<SymbolChoice[]> {
  const q = norm(query);
  if (!q) return [];

  const { entries } = await loadSymbols(kv);
  const ranked: { score: number; e: SymbolEntry }[] = [];
  for (const e of entries) {
    const k = norm(e.key);
    const v = norm(e.value);
    let score: number;
    if (k === q || v === q) score = 0;
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
  for (const { e } of ranked) push({ name: `${e.key} (${e.value})`, value: e.value });

  if (out.length < MAX && isAsciiQuery(query.trim()) && q.length >= 2) {
    for (const c of await searchYahoo(query.trim())) push(c);
  }
  return out;
}

export async function searchYahoo(query: string): Promise<SymbolChoice[]> {
  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(query)}&quotesCount=${MAX}&newsCount=0&listsCount=0`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 stock-chart-bot" },
      cf: { cacheTtl: 3600, cacheEverything: true },
    } as RequestInit);
  } catch {
    return [];
  }
  if (!res.ok) return [];

  const json = (await res.json()) as any;
  const quotes: any[] = json?.quotes ?? [];
  return quotes
    .filter((x) => typeof x?.symbol === "string" && QUOTE_TYPES.has(x.quoteType))
    .map((x) => {
      const label = x.shortname ?? x.longname ?? x.symbol;
      const exch = x.exchDisp ?? x.exchange;
      return { name: `${label} (${x.symbol}${exch ? `, ${exch}` : ""})`.slice(0, 100), value: x.symbol };
    });
}
