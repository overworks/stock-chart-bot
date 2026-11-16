import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanupImages, seedSymbols, PAGE_SIZE, RETENTION_MS, type OperationsClient } from "../supabase/scripts/operations.ts";

const NOW = Date.parse("2026-11-16T00:00:00Z");
const key = (i: number) => `m123-${i.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000.png`;
const file = (i: number, time = NOW - RETENTION_MS - 1) => ({ name: key(i), id: `id-${i}`, created_at: new Date(time).toISOString() });

function storage(initial: { name: string; id: string | null; created_at: string | null }[]) {
  let files = [...initial];
  const list = vi.fn(async (_path: string, options: { limit: number; offset: number }) => ({ data: files.slice(options.offset, options.offset + options.limit), error: null }));
  const remove = vi.fn(async (names: string[]) => {
    const deleted = files.filter((f) => names.includes(f.name));
    files = files.filter((f) => !names.includes(f.name));
    return { data: deleted, error: null };
  });
  const client = { storage: { from: vi.fn(() => ({ list, remove })) } } as unknown as OperationsClient;
  return { client, list, remove, remaining: () => files };
}

beforeEach(() => { vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("외부 요청은 허용하지 않습니다."); })); });
afterEach(() => { vi.unstubAllGlobals(); });

it("replaces only the seed snapshot and preserves canonical and alias entries on repeated writes", async () => {
  const upsert = vi.fn(() => ({ select: async () => ({ error: null, data: [{ id: "symbols:v1" }] }) }));
  const from = vi.fn(() => ({ upsert }));
  const client = { from } as unknown as OperationsClient;
  const entries = [{ key: "삼성전자", value: "005930.KS" }, { key: "삼전", value: "005930.KS", alias: true }];
  expect(await seedSymbols(client, entries)).toBe(2);
  expect(await seedSymbols(client, entries)).toBe(2);
  expect(from.mock.calls).toEqual([["chart_symbol_catalog"], ["chart_symbol_catalog"]]);
  expect(upsert).toHaveBeenLastCalledWith({ id: "symbols:v1", entries }, { onConflict: "id", ignoreDuplicates: false });
});

it("bootstraps atomically without overwriting a catalog that a concurrent refresh created", async () => {
  const upsert = vi.fn(() => ({ select: async () => ({ error: null, data: [] }) }));
  const client = { from: () => ({ upsert }) } as unknown as OperationsClient;
  const entries = [{ key: "애플", value: "AAPL" }];
  expect(await seedSymbols(client, entries, { onlyIfMissing: true })).toBe(0);
  expect(upsert).toHaveBeenCalledWith({ id: "symbols:v1", entries }, { onConflict: "id", ignoreDuplicates: true });
});

it("rejects empty, malformed and duplicate canonical seeds before touching storage", async () => {
  const from = vi.fn();
  const client = { from } as unknown as OperationsClient;
  for (const value of [[], {}, [{ key: "", value: "AAPL" }], [{ key: "애플", value: "AAPL", alias: "yes" }],
    [{ key: "애플", value: "AAPL" }, { key: "Apple", value: "AAPL" }]]) await expect(seedSymbols(client, value)).rejects.toThrow();
  expect(from).not.toHaveBeenCalled();
});

it("does not expose SDK row contents in seed errors", async () => {
  const client = { from: () => ({ upsert: () => ({ select: async () => ({ error: { message: "sensitive-row-token" } }) }) }) } as unknown as OperationsClient;
  await expect(seedSymbols(client, [{ key: "애플", value: "AAPL" }])).rejects.toThrow("종목 스냅샷 적재에 실패했습니다.");
});

it("finishes pagination before deleting and respects the 1000-object batch limit", async () => {
  const mock = storage(Array.from({ length: 2001 }, (_, i) => file(i)));
  const result = await cleanupImages(mock.client, { now: NOW });
  expect(result).toMatchObject({ scanned: 2001, expired: 2001, deleted: 2001 });
  expect(mock.list.mock.calls.map((call) => call[1].offset)).toEqual([0, PAGE_SIZE, PAGE_SIZE * 2, 2001]);
  expect(mock.list).toHaveBeenCalledWith("", { limit: PAGE_SIZE, offset: 0, sortBy: { column: "name", order: "asc" } });
  expect(mock.list.mock.invocationCallOrder.at(-1)).toBeLessThan(mock.remove.mock.invocationCallOrder[0]);
  expect(mock.remove.mock.calls.map((call) => call[0].length)).toEqual([1000, 1000, 1]);
  expect(mock.remaining()).toEqual([]);
  expect((await cleanupImages(mock.client, { now: NOW })).deleted).toBe(0);
});

it("continues through short server pages until an empty page", async () => {
  const mock = storage(Array.from({ length: 30 }, (_, i) => file(i)));
  const list = mock.list.getMockImplementation()!;
  mock.list.mockImplementation((path, options) => list(path, { ...options, limit: 7 }));
  expect((await cleanupImages(mock.client, { now: NOW })).deleted).toBe(30);
  expect(mock.list.mock.calls.map((call) => call[1].offset)).toEqual([0, 7, 14, 21, 28, 30]);
});

it("includes the exact 7-day boundary but keeps newer, future, unknown and folder entries", async () => {
  const keep = [file(2, NOW - RETENTION_MS + 1), file(3, NOW + 1),
    { ...file(4), created_at: "invalid" }, { ...file(5), name: "foreign.png" },
    { ...file(6), id: null }, { ...file(7), name: `folder/${key(7)}` }];
  const mock = storage([file(0), file(1, NOW - RETENTION_MS), ...keep]);
  expect(await cleanupImages(mock.client, { now: NOW, dryRun: true })).toMatchObject({ expired: 2, deleted: 0, dryRun: true });
  expect(mock.remove).not.toHaveBeenCalled();
  expect((await cleanupImages(mock.client, { now: NOW })).deleted).toBe(2);
  expect(mock.remaining()).toEqual(keep);
});

it("does not start deletion if a later listing page fails", async () => {
  const mock = storage(Array.from({ length: PAGE_SIZE + 1 }, (_, i) => file(i)));
  mock.list.mockResolvedValueOnce({ data: Array.from({ length: PAGE_SIZE }, (_, i) => file(i)), error: null })
    .mockRejectedValueOnce(new Error("sensitive-row-token"));
  await expect(cleanupImages(mock.client, { now: NOW })).rejects.toThrow("삭제는 시작하지 않았습니다");
  expect(mock.remove).not.toHaveBeenCalled();
});

it("can resume after a partial deletion failure without skipping remaining pages", async () => {
  const mock = storage(Array.from({ length: 2001 }, (_, i) => file(i)));
  const remove = mock.remove.getMockImplementation()!;
  let calls = 0;
  mock.remove.mockImplementation(async (names) => {
    if (++calls === 2) throw new Error("sensitive-row-token");
    return remove(names);
  });
  await expect(cleanupImages(mock.client, { now: NOW })).rejects.toThrow("이미 삭제한 객체는 1000개");
  expect(mock.remaining()).toHaveLength(1001);
  expect((await cleanupImages(mock.client, { now: NOW })).deleted).toBe(1001);
  expect(mock.remaining()).toEqual([]);
});

it("rejects invalid cleanup clocks before any API access", async () => {
  const mock = storage([file(0)]);
  for (const now of [NaN, Infinity, 1e100]) await expect(cleanupImages(mock.client, { now })).rejects.toThrow("기준 시각");
  expect(mock.list).not.toHaveBeenCalled();
  expect(mock.remove).not.toHaveBeenCalled();
});
