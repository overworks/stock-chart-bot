import type { SymbolEntry } from "../../src/core/storage.ts";
import { CHARTS_BUCKET, SYMBOLS_KEY, type createChartClient } from "../functions/stock-chart-bot/adapters.ts";

export type OperationsClient = ReturnType<typeof createChartClient>;
export const PAGE_SIZE = 1000;
export const DELETE_BATCH_SIZE = 1000;
export const RETENTION_MS = 7 * 86_400_000;
const CHART_KEY = /^[a-z0-9]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/;

export class OperationError extends Error { override name = "OperationError"; }

export function parseSeed(value: unknown): SymbolEntry[] {
  if (!Array.isArray(value) || !value.length) throw new OperationError("비어 있지 않은 종목 목록이 필요합니다.");
  const canonical = new Set<string>();
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("key" in item) || !("value" in item)
      || typeof item.key !== "string" || !item.key.trim() || typeof item.value !== "string" || !item.value.trim()
      || ("alias" in item && typeof item.alias !== "boolean")) throw new OperationError("종목 목록 형식이 올바르지 않습니다.");
    const alias = "alias" in item && typeof item.alias === "boolean" ? item.alias : undefined;
    if (!alias) {
      if (canonical.has(item.value)) throw new OperationError("심볼당 정식 종목명은 하나여야 합니다.");
      canonical.add(item.value);
    }
    return { key: item.key, value: item.value, ...(alias === undefined ? {} : { alias }) };
  });
}

export async function seedSymbols(client: OperationsClient, value: unknown, options: { onlyIfMissing?: boolean } = {}): Promise<number> {
  const entries = parseSeed(value);
  try {
    const { data, error } = await client.from("chart_symbol_catalog").upsert(
      { id: SYMBOLS_KEY, entries: entries.map((item) => ({ ...item })) },
      { onConflict: "id", ignoreDuplicates: !!options.onlyIfMissing },
    ).select("id");
    if (error || !Array.isArray(data) || (!options.onlyIfMissing && data.length !== 1)) throw error;
    return data.length ? entries.length : 0;
  } catch { throw new OperationError("종목 스냅샷 적재에 실패했습니다."); }
}

export async function cleanupImages(client: OperationsClient, options: { now?: number; dryRun?: boolean } = {}) {
  const now = options.now ?? Date.now();
  const cutoff = now - RETENTION_MS;
  if (!Number.isFinite(now) || !Number.isFinite(new Date(cutoff).getTime())) throw new OperationError("이미지 정리 기준 시각이 올바르지 않습니다.");
  const bucket = client.storage.from(CHARTS_BUCKET);
  const expired = new Set<string>();
  let scanned = 0;
  for (let offset = 0; ;) {
    let page;
    try {
      const { data, error } = await bucket.list("", { limit: PAGE_SIZE, offset, sortBy: { column: "name", order: "asc" } });
      if (error || !Array.isArray(data)) throw error;
      page = data;
    } catch { throw new OperationError("차트 이미지 목록 조회에 실패했습니다. 삭제는 시작하지 않았습니다."); }
    for (const file of page) {
      scanned++;
      const created = typeof file.created_at === "string" ? Date.parse(file.created_at) : NaN;
      if (file.id && CHART_KEY.test(file.name) && Number.isFinite(created) && created <= cutoff) expired.add(file.name);
    }
    if (!page.length) break;
    offset += page.length;
  }
  const names = [...expired];
  let deleted = 0;
  if (!options.dryRun) {
    for (let i = 0; i < names.length; i += DELETE_BATCH_SIZE) {
      try {
        const { data, error } = await bucket.remove(names.slice(i, i + DELETE_BATCH_SIZE));
        if (error || !Array.isArray(data)) throw error;
        deleted += data.length;
      } catch { throw new OperationError(`차트 이미지 삭제에 실패했습니다. 이미 삭제한 객체는 ${deleted}개입니다. 재실행할 수 있습니다.`); }
    }
  }
  return { scanned, expired: names.length, deleted, cutoff: new Date(cutoff).toISOString(), dryRun: !!options.dryRun };
}
