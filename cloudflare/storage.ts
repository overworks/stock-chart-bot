import { logEvent } from "../src/core/log.ts";
import type { CachedToken, SymbolEntry, SymbolStore, TokenCache } from "../src/core/storage.ts";

export const SYMBOLS_KEY = "symbols:v1";
export const ALIASES_KEY = "aliases:v1";
export const KIS_TOKEN_KEY = "kis:token:v1";

export function createSymbolStore(env: { KV: KVNamespace; ALIAS_WRITER: DurableObjectNamespace }): SymbolStore {
  return {
    async readSeed() {
      const entries = (await env.KV.get<SymbolEntry[]>(SYMBOLS_KEY, "json")) ?? [];
      if (!entries.length) logEvent("error", "chart.symbols.missing", { "chart.symbols.key": SYMBOLS_KEY });
      return entries;
    },
    async readAliases() {
      return (await env.KV.get<SymbolEntry[]>(ALIASES_KEY, "json")) ?? [];
    },
    async mutateAlias(mutation) {
      const stub = env.ALIAS_WRITER.get(env.ALIAS_WRITER.idFromName(ALIASES_KEY));
      const response = await stub.fetch("https://aliases/mutate", {
        method: "POST",
        body: JSON.stringify(mutation),
      });
      if (!response.ok) throw new Error(await response.text());
      return response.json<SymbolEntry>();
    },
  };
}

export function createKisTokenCache(kv: KVNamespace): TokenCache {
  return {
    get: () => kv.get<CachedToken>(KIS_TOKEN_KEY, "json"),
    async put(token, ttlSeconds) {
      await kv.put(KIS_TOKEN_KEY, JSON.stringify(token), { expirationTtl: ttlSeconds });
    },
  };
}
