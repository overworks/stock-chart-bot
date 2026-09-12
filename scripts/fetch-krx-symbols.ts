import { readFileSync, writeFileSync } from "node:fs";

const KIND = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=";
const MARKETS: Record<string, string> = { stockMkt: "KS", kosdaqMkt: "KQ" };
const NAVER = "https://finance.naver.com/api/sise/";
// ETF·ETN은 KIND 상장법인 목록에 없어 네이버 금융 목록을 쓴다. 모두 코스피 상장(.KS).
const FUNDS: { path: string; field: string; min: number }[] = [
  { path: "etfItemList.nhn?etfType=0", field: "etfItemList", min: 300 },
  { path: "etnItemList.nhn?etnType=0", field: "etnItemList", min: 50 },
];
const UPBIT = "https://api.upbit.com/v1/market/all?is_details=false";
const UA = { "User-Agent": "Mozilla/5.0 stock-chart-bot" };
// 2025년부터 영문이 섞인 6자리 코드(0167A0 등)도 쓰인다.
const CODE = /^[0-9A-Z]{6}$/;

type Entry = { key: string; value: string; alias?: true };

async function fetchMarket(market: string, suffix: string): Promise<Entry[]> {
  const res = await fetch(KIND + market, { headers: UA });
  if (!res.ok) throw new Error(`${market}: HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  const entries: Entry[] = [];
  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length < 3) continue;
    const [name, , code] = cells;
    if (!CODE.test(code)) continue;
    entries.push({ key: name, value: `${code}.${suffix}` });
  }
  if (entries.length < 100) throw new Error(`${market}: parsed only ${entries.length} rows, format may have changed`);
  return entries;
}

async function fetchFunds(path: string, field: string, min: number): Promise<Entry[]> {
  const res = await fetch(NAVER + path, { headers: UA });
  if (!res.ok) throw new Error(`${field}: HTTP ${res.status}`);
  const json = JSON.parse(new TextDecoder("euc-kr").decode(await res.arrayBuffer()));
  const items: { itemcode: string; itemname: string }[] = json?.result?.[field] ?? [];
  const entries = items
    .filter((i) => CODE.test(i.itemcode) && i.itemname?.trim())
    .map((i) => ({ key: i.itemname.trim(), value: `${i.itemcode}.KS` }));
  if (entries.length < min) throw new Error(`${field}: parsed only ${entries.length} rows, format may have changed`);
  return entries;
}

// 업비트 원화 마켓. 한글 이름 → KRW-BTC. 시세는 providers/upbit.ts가 맡는다.
async function fetchUpbit(): Promise<Entry[]> {
  const res = await fetch(UPBIT, { headers: UA });
  if (!res.ok) throw new Error(`upbit: HTTP ${res.status}`);
  const items: { market: string; korean_name: string }[] = await res.json();
  const entries = items
    .filter((m) => /^KRW-[A-Z0-9]+$/.test(m.market) && m.korean_name?.trim())
    .map((m) => ({ key: m.korean_name.trim(), value: m.market }));
  if (entries.length < 100) throw new Error(`upbit: parsed only ${entries.length} rows, format may have changed`);
  return entries;
}

const manual: Entry[] = JSON.parse(readFileSync("scripts/symbols.manual.json", "utf8"));
const [stocks, funds, crypto] = await Promise.all([
  Promise.all(Object.entries(MARKETS).map(([m, s]) => fetchMarket(m, s))).then((r) => r.flat()),
  Promise.all(FUNDS.map((f) => fetchFunds(f.path, f.field, f.min))).then((r) => r.flat()),
  fetchUpbit(),
]);
// 수동 항목이 우선. KIND에 같은 행이 두 번 나오거나 종목명이 코인명과 겹치면(하이브 등) 앞선 것만 남긴다.
const manualKeys = new Set(manual.map((e) => e.key));
const seenValue = new Set<string>();
const seenKey = new Set<string>(manualKeys);
const krx = [...stocks, ...funds, ...crypto].filter(
  (e) => !seenValue.has(e.value) && !seenKey.has(e.key) && seenValue.add(e.value) && seenKey.add(e.key),
);

// 심볼당 정식명은 하나다. KRX·업비트 목록에 있으면 그 이름, 없으면 수동 목록의 첫 항목. 나머지는 alias로 표시한다.
const canonical = new Map(krx.map((e) => [e.value, e.key]));
const manualOut: Entry[] = manual.map((e) => {
  const name = canonical.get(e.value);
  if (name === undefined) {
    canonical.set(e.value, e.key);
    return { key: e.key, value: e.value };
  }
  return { key: e.key, value: e.value, alias: true };
});
const out = [...manualOut, ...krx.sort((a, b) => a.key.localeCompare(b.key, "ko"))];
writeFileSync("scripts/symbols.json", JSON.stringify(out, null, 2) + "\n");
const aliases = manualOut.filter((e) => e.alias).length;
console.log(`KRX 주식 ${stocks.length}개 + ETF/ETN ${funds.length}개 + 업비트 ${crypto.length}개 + 수동 ${manual.length}개(별칭 ${aliases}개) → ${out.length}개 → scripts/symbols.json`);
