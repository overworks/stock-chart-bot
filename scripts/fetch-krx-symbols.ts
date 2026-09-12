import { readFileSync, writeFileSync } from "node:fs";

const KIND = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=";
const MARKETS: Record<string, string> = { stockMkt: "KS", kosdaqMkt: "KQ" };
const NAVER = "https://finance.naver.com/api/sise/";
// ETF·ETN은 KIND 상장법인 목록에 없어 네이버 금융 목록을 쓴다. 모두 코스피 상장(.KS).
const FUNDS: { path: string; field: string; min: number }[] = [
  { path: "etfItemList.nhn?etfType=0", field: "etfItemList", min: 300 },
  { path: "etnItemList.nhn?etnType=0", field: "etnItemList", min: 50 },
];
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

const manual: Entry[] = JSON.parse(readFileSync("scripts/symbols.manual.json", "utf8"));
const [stocks, funds] = await Promise.all([
  Promise.all(Object.entries(MARKETS).map(([m, s]) => fetchMarket(m, s))).then((r) => r.flat()),
  Promise.all(FUNDS.map((f) => fetchFunds(f.path, f.field, f.min))).then((r) => r.flat()),
]);
// KIND 목록에 같은 행이 두 번 나오는 경우가 있어 코드 기준으로 중복을 제거한다.
const seen = new Set<string>();
const krx = [...stocks, ...funds].filter((e) => !seen.has(e.value) && seen.add(e.value));

// 심볼당 정식명은 하나다. KRX에 있으면 KRX 회사명, 없으면 수동 목록의 첫 항목. 나머지는 alias로 표시한다.
const canonical = new Map(krx.map((e) => [e.value, e.key]));
const manualOut: Entry[] = manual.map((e) => {
  const name = canonical.get(e.value);
  if (name === undefined) {
    canonical.set(e.value, e.key);
    return { key: e.key, value: e.value };
  }
  return name === e.key ? { key: e.key, value: e.value } : { key: e.key, value: e.value, alias: true };
});
const manualKeys = new Set(manual.map((e) => e.key));
const out = [
  ...manualOut,
  ...krx.filter((e) => !manualKeys.has(e.key)).sort((a, b) => a.key.localeCompare(b.key, "ko")),
];
writeFileSync("scripts/symbols.json", JSON.stringify(out, null, 2) + "\n");
const aliases = manualOut.filter((e) => e.alias).length;
console.log(`KRX 주식 ${stocks.length}개 + ETF/ETN ${funds.length}개 + 수동 ${manual.length}개(별칭 ${aliases}개) → ${out.length}개 → scripts/symbols.json`);
