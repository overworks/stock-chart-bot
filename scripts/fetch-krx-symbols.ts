import { readFileSync, writeFileSync } from "node:fs";

const KIND = "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=";
const MARKETS: Record<string, string> = { stockMkt: "KS", kosdaqMkt: "KQ" };

type Entry = { key: string; value: string; alias?: true };

async function fetchMarket(market: string, suffix: string): Promise<Entry[]> {
  const res = await fetch(KIND + market, { headers: { "User-Agent": "Mozilla/5.0 stock-chart-bot" } });
  if (!res.ok) throw new Error(`${market}: HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)];
  const entries: Entry[] = [];
  for (const [, row] of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    if (cells.length < 3) continue;
    const [name, , code] = cells;
    if (!/^\d{6}$/.test(code)) continue;
    entries.push({ key: name, value: `${code}.${suffix}` });
  }
  if (entries.length < 100) throw new Error(`${market}: parsed only ${entries.length} rows, format may have changed`);
  return entries;
}

const manual: Entry[] = JSON.parse(readFileSync("scripts/symbols.manual.json", "utf8"));
const krx = (await Promise.all(Object.entries(MARKETS).map(([m, s]) => fetchMarket(m, s)))).flat();

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
console.log(`KRX ${krx.length}개 + 수동 ${manual.length}개(별칭 ${aliases}개) → ${out.length}개 → scripts/symbols.json`);
