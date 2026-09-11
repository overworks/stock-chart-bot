import { getPrices, SymbolNotFoundError } from "./market";
import {
  ALIASES_KEY,
  isAsciiQuery,
  loadSymbols,
  looksLikeSymbol,
  resetSymbolCache,
  searchSymbols,
  type SymbolEntry,
} from "./symbols";

export type AliasAction = "add" | "remove" | "list";

export interface AliasArgs {
  action?: string;
  alias?: string;
  target?: string;
}

const MAX_ALIAS_LEN = 40;
const LIST_LIMIT = 50;

export const ALIAS_USAGE =
  "사용법: `/alias add <별칭> <종목명|심볼>`, `/alias remove <별칭>`, `/alias list`";

export async function listAliases(kv: KVNamespace): Promise<SymbolEntry[]> {
  return (await kv.get<SymbolEntry[]>(ALIASES_KEY, "json")) ?? [];
}

/** 사용자 별칭을 추가한다. 종목은 이름·심볼 어느 쪽이든 받고, 실제 심볼로 확정해 저장한다. */
export async function addAlias(
  kv: KVNamespace,
  aliasInput: string,
  targetInput: string,
): Promise<{ alias: string; symbol: string; display: string }> {
  const alias = aliasInput.trim();
  const target = targetInput.trim();
  if (!alias || !target) throw new Error(ALIAS_USAGE);
  if (alias.length > MAX_ALIAS_LEN) throw new Error(`별칭은 ${MAX_ALIAS_LEN}자 이하여야 합니다.`);
  if (looksLikeSymbol(alias)) throw new Error("심볼 형식(005930.KS, KRW=X 등)은 별칭으로 쓸 수 없습니다.");

  const user = await listAliases(kv);
  const { byKey, byValue } = await loadSymbols(kv);
  const existing = byKey.get(alias);
  if (existing !== undefined && !user.some((e) => e.key === alias)) {
    throw new Error(`'${alias}'은(는) 이미 종목명으로 등록돼 있습니다 (${existing}).`);
  }

  const { symbol, display } = await resolveTarget(target, kv, byKey, byValue);
  const next = [...user.filter((e) => e.key !== alias), { key: alias, value: symbol }];
  await kv.put(ALIASES_KEY, JSON.stringify(next));
  resetSymbolCache();
  return { alias, symbol, display };
}

export async function removeAlias(kv: KVNamespace, aliasInput: string): Promise<SymbolEntry> {
  const alias = aliasInput.trim();
  if (!alias) throw new Error(ALIAS_USAGE);
  const user = await listAliases(kv);
  const hit = user.find((e) => e.key === alias);
  if (!hit) throw new Error(`'${alias}' 별칭이 없습니다.`);
  await kv.put(ALIASES_KEY, JSON.stringify(user.filter((e) => e.key !== alias)));
  resetSymbolCache();
  return hit;
}

async function resolveTarget(
  target: string,
  kv: KVNamespace,
  byKey: Map<string, string>,
  byValue: Map<string, string>,
): Promise<{ symbol: string; display: string }> {
  const known = byKey.get(target);
  if (known !== undefined) return { symbol: known, display: label(known, byValue) };

  const notFound = new Error(`'${target}' 종목을 찾지 못했습니다.`);
  if (!looksLikeSymbol(target)) {
    const hit = (await searchSymbols(target, kv))[0];
    if (hit) return { symbol: hit.value, display: byValue.has(hit.value) ? label(hit.value, byValue) : hit.name };
    if (!isAsciiQuery(target)) throw notFound;
  }
  try {
    const series = await getPrices(target, { ticker: target, range: "1m" });
    return { symbol: target, display: label(target, byValue, series.name) };
  } catch (err) {
    if (err instanceof SymbolNotFoundError) throw notFound;
    throw err;
  }
}

function label(symbol: string, byValue: Map<string, string>, fallback?: string): string {
  const name = byValue.get(symbol) ?? fallback;
  return name && name !== symbol ? `${name} (${symbol})` : symbol;
}

/** 어댑터 공용 진입점. 결과 메시지를 돌려주고 실패는 Error로 던진다. */
export async function runAlias(args: AliasArgs, env: { SYMBOLS: KVNamespace }): Promise<string> {
  switch (args.action) {
    case "add": {
      const r = await addAlias(env.SYMBOLS, args.alias ?? "", args.target ?? "");
      return `✅ 별칭 추가: ${r.alias} → ${r.display}`;
    }
    case "remove": {
      const r = await removeAlias(env.SYMBOLS, args.alias ?? "");
      return `🗑️ 별칭 삭제: ${r.key} → ${r.value}`;
    }
    case "list": {
      const user = await listAliases(env.SYMBOLS);
      if (!user.length) return "등록된 별칭이 없습니다.";
      const { byValue } = await loadSymbols(env.SYMBOLS);
      const lines = user.slice(0, LIST_LIMIT).map((e) => `• ${e.key} → ${label(e.value, byValue)}`);
      if (user.length > LIST_LIMIT) lines.push(`… 외 ${user.length - LIST_LIMIT}개`);
      return lines.join("\n");
    }
    default:
      throw new Error(ALIAS_USAGE);
  }
}

/** `/alias remove` 자동완성용 */
export async function searchAliases(query: string, kv: KVNamespace): Promise<{ name: string; value: string }[]> {
  const q = query.trim().toLowerCase();
  const user = await listAliases(kv);
  const { byValue } = await loadSymbols(kv);
  return user
    .filter((e) => !q || e.key.toLowerCase().includes(q))
    .slice(0, 25)
    .map((e) => ({ name: `${e.key} → ${label(e.value, byValue)}`, value: e.key }));
}
