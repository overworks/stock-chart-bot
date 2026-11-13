import { afterEach, expect, it, vi } from "vitest";
import { addAlias, removeAlias } from "../src/core/aliases";
import type { AliasMutation, SymbolEntry, SymbolStore } from "../src/core/storage";
import { resetSymbolCache, resolveSymbol } from "../src/core/symbols";

function memoryStore(value = "AAPL") {
  let aliases: SymbolEntry[] = [];
  const readSeed = vi.fn(async () => [{ key: "공통종목", value }]);
  const readAliases = vi.fn(async () => [...aliases]);
  const mutateAlias = vi.fn(async (mutation: AliasMutation) => {
    const entry = mutation.value === undefined
      ? aliases.find((item) => item.key === mutation.key)
      : { key: mutation.key, value: mutation.value };
    if (!entry) throw new Error("별칭이 없습니다.");
    aliases = aliases.filter((item) => item.key !== mutation.key);
    if (mutation.value !== undefined) aliases.push(entry);
    return entry;
  });
  const store: SymbolStore = { readSeed, readAliases, mutateAlias };
  return { store, readSeed, readAliases, mutateAlias };
}

afterEach(() => {
  resetSymbolCache();
  vi.restoreAllMocks();
});

it("keeps cached symbol data separate for each repository", async () => {
  const first = memoryStore("AAPL");
  const second = memoryStore("MSFT");
  expect(await resolveSymbol("공통종목", first.store)).toBe("AAPL");
  expect(await resolveSymbol("공통종목", second.store)).toBe("MSFT");
  expect(await resolveSymbol("공통종목", first.store)).toBe("AAPL");
  expect(first.readSeed).toHaveBeenCalledTimes(1);
  expect(second.readSeed).toHaveBeenCalledTimes(1);
});

it("shares concurrent cold and expired loads within the ten-minute cache window", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
  const { store, readSeed, readAliases } = memoryStore();
  await Promise.all([resolveSymbol("공통종목", store), resolveSymbol("공통종목", store)]);
  clock.mockReturnValue(600_999);
  await resolveSymbol("공통종목", store);
  expect(readSeed).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(601_000);
  await Promise.all([resolveSymbol("공통종목", store), resolveSymbol("공통종목", store)]);
  expect(readSeed).toHaveBeenCalledTimes(2);
  expect(readAliases).toHaveBeenCalledTimes(2);
});

it("retries a failed repository read instead of caching the failure", async () => {
  const { store, readAliases } = memoryStore();
  readAliases.mockRejectedValueOnce(new Error("storage unavailable"));
  await expect(resolveSymbol("공통종목", store)).rejects.toThrow("storage unavailable");
  expect(await resolveSymbol("공통종목", store)).toBe("AAPL");
  expect(readAliases).toHaveBeenCalledTimes(2);
});

it("does not discard a refreshed cache when an invalidated read fails later", async () => {
  const { store, readSeed } = memoryStore();
  let rejectRead!: (error: Error) => void;
  readSeed.mockImplementationOnce(() => new Promise((_, reject) => { rejectRead = reject; }));
  const failed = expect(resolveSymbol("공통종목", store)).rejects.toThrow("old read");
  resetSymbolCache(store);
  expect(await resolveSymbol("공통종목", store)).toBe("AAPL");
  rejectRead(new Error("old read"));
  await failed;
  expect(await resolveSymbol("공통종목", store)).toBe("AAPL");
  expect(readSeed).toHaveBeenCalledTimes(2);
});

it("delegates alias mutations with request identity and invalidates only that repository", async () => {
  const first = memoryStore();
  const second = memoryStore("MSFT");
  await resolveSymbol("새별칭", first.store);
  await resolveSymbol("공통종목", second.store);
  const request = { key: "discord:request", expiresAt: Date.now() + 60_000 };
  await addAlias(first.store, "새별칭", "공통종목", [], request);
  expect(first.mutateAlias).toHaveBeenCalledWith({ key: "새별칭", value: "AAPL", request });
  expect(await resolveSymbol("새별칭", first.store)).toBe("AAPL");
  expect(await resolveSymbol("공통종목", second.store)).toBe("MSFT");
  expect(second.readSeed).toHaveBeenCalledTimes(1);
  await removeAlias("새별칭", first.store);
  expect(await resolveSymbol("새별칭", first.store)).toBe("새별칭");
});

it("preserves a mutation failure without reporting success or clearing other data", async () => {
  const { store, mutateAlias, readSeed } = memoryStore();
  await resolveSymbol("공통종목", store);
  mutateAlias.mockRejectedValueOnce(new Error("publication delayed"));
  await expect(addAlias(store, "새별칭", "공통종목", [])).rejects.toThrow("publication delayed");
  expect(await resolveSymbol("새별칭", store)).toBe("새별칭");
  expect(readSeed).toHaveBeenCalledTimes(1);
});
