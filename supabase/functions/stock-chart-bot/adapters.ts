import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { logEvent } from "../../../src/core/log.ts";
import type { ImagePublisher } from "../../../src/core/runtime.ts";
import type { SymbolEntry, SymbolStore, TokenCache } from "../../../src/core/storage.ts";
import type { Database } from "./database.types.ts";

export const SYMBOLS_KEY = "symbols:v1";
export const KIS_TOKEN_KEY = "kis:token:v1";
export const CHARTS_BUCKET = "charts";
type Client = SupabaseClient<Database>;

export function createChartClient(url: string, serviceKey: string): Client {
  return createClient<Database>(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entry(value: unknown): value is SymbolEntry {
  return object(value) && typeof value.key === "string" && typeof value.value === "string"
    && (value.alias === undefined || typeof value.alias === "boolean");
}

function entries(value: unknown): SymbolEntry[] {
  if (!Array.isArray(value) || !value.every(entry)) throw new Error("종목 목록 형식이 올바르지 않습니다.");
  return value.map((item) => ({ key: item.key, value: item.value, ...(item.alias === undefined ? {} : { alias: item.alias }) }));
}

export function createSymbolStore(client: Client): SymbolStore {
  return {
    async readSeed() {
      const { data, error } = await client.from("chart_symbol_catalog").select("entries").eq("id", SYMBOLS_KEY).maybeSingle();
      if (error) throw new Error("종목 목록을 불러오지 못했습니다.");
      const result = entries(data?.entries ?? []);
      if (!result.length) logEvent("error", "chart.symbols.missing", { "chart.symbols.table": "chart_symbol_catalog" });
      return result;
    },
    async readAliases() {
      const { data, error } = await client.rpc("read_chart_aliases");
      if (error) throw new Error("별칭 목록을 불러오지 못했습니다.");
      return entries(data);
    },
    async mutateAlias(mutation) {
      const { data, error } = await client.rpc("mutate_chart_alias", {
        p_key: mutation.key,
        p_value: mutation.value,
        p_request_key: mutation.request?.key,
        p_expires_at_ms: mutation.request?.expiresAt,
      });
      if (error) throw new Error("별칭 변경에 실패했습니다.");
      if (object(data) && object(data.error)) {
        const messages: Record<number, string> = {
          400: "별칭 변경 인자가 올바르지 않습니다.",
          404: `'${mutation.key}' 별칭이 없습니다.`,
          408: "별칭 변경 요청이 만료됐습니다. 다시 실행해 주세요.",
          409: "이미 처리한 별칭 변경 요청입니다.",
        };
        throw new Error(messages[Number(data.error.status)] ?? "별칭 변경에 실패했습니다.");
      }
      if (!object(data) || !entry(data.entry)) throw new Error("별칭 변경 응답 형식이 올바르지 않습니다.");
      return { key: data.entry.key, value: data.entry.value };
    },
  };
}

export function createKisTokenCache(client: Client): TokenCache {
  return {
    async get() {
      const { data, error } = await client.from("chart_token_cache")
        .select("token, token_expires_at_sec").eq("key", KIS_TOKEN_KEY).gt("expires_at_ms", Date.now()).maybeSingle();
      if (error) throw new Error("시세 토큰 캐시를 불러오지 못했습니다.");
      return data ? { token: data.token, expiresAt: data.token_expires_at_sec } : null;
    },
    async put(token, ttlSeconds) {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) throw new Error("시세 토큰 캐시 만료 시간이 올바르지 않습니다.");
      const { error } = await client.from("chart_token_cache").upsert({
        key: KIS_TOKEN_KEY,
        token: token.token,
        token_expires_at_sec: token.expiresAt,
        expires_at_ms: Date.now() + ttlSeconds * 1000,
      });
      if (error) throw new Error("시세 토큰 캐시를 저장하지 못했습니다.");
    },
  };
}

export function createImagePublisher(client: Client): ImagePublisher {
  return {
    async publish(png) {
      const key = `${Date.now().toString(36)}-${crypto.randomUUID()}.png`;
      const { error } = await client.storage.from(CHARTS_BUCKET).upload(key, new Uint8Array(png), {
        contentType: "image/png", cacheControl: "86400", upsert: false,
      });
      if (error) throw new Error("차트 이미지를 저장하지 못했습니다.");
      return client.storage.from(CHARTS_BUCKET).getPublicUrl(key).data.publicUrl;
    },
  };
}
