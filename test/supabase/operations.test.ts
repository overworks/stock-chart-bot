import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { createChartClient, createImagePublisher, createSymbolStore, SYMBOLS_KEY } from "../../supabase/functions/stock-chart-bot/adapters.ts";
import { cleanupImages, RETENTION_MS, seedSymbols } from "../../supabase/scripts/operations.ts";

const local = env as unknown as { SUPABASE_TEST_URL: string; SUPABASE_TEST_SERVICE_KEY: string };
const admin = createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_SERVICE_KEY);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

it("repeats seed replacement without modifying persisted user aliases", async () => {
  const store = createSymbolStore(admin);
  const name = `적재검증-${crypto.randomUUID().slice(0, 8)}`;
  await store.mutateAlias({ key: name, value: "AAPL" });
  try {
    const entries = [{ key: "새정식명", value: "AAPL" }, { key: "새별칭", value: "AAPL", alias: true }];
    if ((await admin.from("chart_symbol_catalog").delete().eq("id", SYMBOLS_KEY)).error) throw new Error("검증 종목 초기화에 실패했습니다.");
    expect(await seedSymbols(admin, [{ key: "초기명", value: "AAPL" }], { onlyIfMissing: true })).toBe(1);
    await seedSymbols(admin, entries);
    await seedSymbols(admin, entries);
    expect(await seedSymbols(admin, [{ key: "이전명", value: "AAPL" }], { onlyIfMissing: true })).toBe(0);
    expect((await admin.from("chart_symbol_catalog").select("entries").eq("id", SYMBOLS_KEY).single()).data?.entries).toEqual(entries);
    expect(await store.readAliases()).toContainEqual({ key: name, value: "AAPL" });
    await expect(seedSymbols(admin, [])).rejects.toThrow();
    expect(await store.readSeed()).toEqual(entries);
  } finally { await store.mutateAlias({ key: name }); }
});

it("expires real Storage files at 7 days and preserves recent, future and unrelated objects", async () => {
  const now = Date.now();
  const bucket = admin.storage.from("charts");
  const publisher = createImagePublisher(admin);
  const keys: string[] = [];
  async function age(name: string, time: number) {
    const response = await fetch(`${local.SUPABASE_TEST_URL}/rest/v1/rpc/chart_test_set_image_time`, {
      method: "POST", headers: { apikey: local.SUPABASE_TEST_SERVICE_KEY, authorization: `Bearer ${local.SUPABASE_TEST_SERVICE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ p_name: name, p_created_at: new Date(time).toISOString() }),
    });
    if (!response.ok) throw new Error("검증 이미지 시각 설정에 실패했습니다.");
  }
  try {
    for (let i = 0; i < 4; i++) {
      keys.push(new URL(await publisher.publish(PNG, "https://bot.test")).pathname.split("/").at(-1)!);
    }
    const foreign = `unrelated_${crypto.randomUUID()}.png`;
    const nested = `folder-${crypto.randomUUID()}/keep.png`;
    for (const name of [foreign, nested]) {
      if ((await bucket.upload(name, PNG, { contentType: "image/png" })).error) throw new Error("검증 이미지 적재에 실패했습니다.");
      keys.push(name);
    }
    for (const [index, time] of [now - RETENTION_MS - 1, now - RETENTION_MS, now - RETENTION_MS + 1, now + 86_400_000, now - RETENTION_MS - 1, now - RETENTION_MS - 1].entries()) await age(keys[index], time);
    expect(await cleanupImages(admin, { now, dryRun: true })).toMatchObject({ expired: 2, deleted: 0 });
    expect((await bucket.download(keys[0])).error).toBeNull();
    expect(await cleanupImages(admin, { now })).toMatchObject({ expired: 2, deleted: 2 });
    for (const name of keys.slice(0, 2)) expect((await bucket.download(name)).error).not.toBeNull();
    for (const name of keys.slice(2)) expect((await bucket.download(name)).error).toBeNull();
    expect((await cleanupImages(admin, { now })).deleted).toBe(0);
  } finally {
    if (keys.length && (await bucket.remove(keys)).error) throw new Error("검증 이미지 정리에 실패했습니다.");
  }
});
