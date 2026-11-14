import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { addAlias } from "../../src/core/aliases.ts";
import { resetSymbolCache, resolveSymbol, symbolName } from "../../src/core/symbols.ts";
import {
  CHARTS_BUCKET, KIS_TOKEN_KEY, SYMBOLS_KEY, createChartClient, createImagePublisher,
  createKisTokenCache, createSymbolStore,
} from "../../supabase/functions/stock-chart-bot/adapters.ts";

const local = env as unknown as {
  SUPABASE_TEST_URL: string; SUPABASE_TEST_SERVICE_KEY: string; SUPABASE_TEST_ANON_KEY: string;
};
const admin = createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_SERVICE_KEY);
const store = createSymbolStore(admin);
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), (char) => char.charCodeAt(0));

async function ok(operation: PromiseLike<{ error: unknown }>): Promise<void> {
  if ((await operation).error) throw new Error("로컬 DB 검증 작업에 실패했습니다.");
}

beforeEach(async () => {
  resetSymbolCache();
  await Promise.all([
    ok(admin.from("chart_aliases").delete().neq("alias", "")),
    ok(admin.from("chart_alias_requests").delete().neq("request_key", "")),
    ok(admin.from("chart_token_cache").delete().eq("key", KIS_TOKEN_KEY)),
    ok(admin.from("chart_symbol_catalog").upsert({ id: SYMBOLS_KEY, entries: [
      { key: "삼성전자", value: "005930.KS" }, { key: "애플", value: "AAPL" },
    ] })),
  ]);
});

it("integrates canonical symbols and aliases without coupling seed refreshes to user data", async () => {
  expect(await addAlias(store, "내삼전", "삼성전자", [])).toMatchObject({ symbol: "005930.KS" });
  expect(await resolveSymbol("내삼전", store)).toBe("005930.KS");
  await ok(admin.from("chart_symbol_catalog").upsert({ id: SYMBOLS_KEY, entries: [{ key: "새정식명", value: "005930.KS" }] }));
  resetSymbolCache(store);
  expect(await symbolName("005930.KS", store)).toBe("새정식명");
  expect(await store.readAliases()).toEqual([{ key: "내삼전", value: "005930.KS" }]);
});

it("serializes concurrent additions and mixed mutations without losing entries", async () => {
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.mutateAlias({ key: `동시${i}`, value: "AAPL" })));
  expect(await store.readAliases()).toHaveLength(12);
  await Promise.all([
    ...Array.from({ length: 6 }, (_, i) => store.mutateAlias({ key: `동시${i}` })),
    ...Array.from({ length: 6 }, (_, i) => store.mutateAlias({ key: `동시${i + 12}`, value: "MSFT" })),
  ]);
  expect((await store.readAliases()).map((item) => item.key).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `동시${i + 6}`).sort());
});

it("moves an overwritten alias to the end like the existing durable store", async () => {
  await store.mutateAlias({ key: "첫째", value: "AAPL" });
  await store.mutateAlias({ key: "둘째", value: "MSFT" });
  await store.mutateAlias({ key: "첫째", value: "GOOG" });
  expect(await store.readAliases()).toEqual([{ key: "둘째", value: "MSFT" }, { key: "첫째", value: "GOOG" }]);
  expect(await store.mutateAlias({ key: "첫째" })).toEqual({ key: "첫째", value: "GOOG" });
  await expect(store.mutateAlias({ key: "첫째" })).rejects.toThrow("별칭이 없습니다");
});

it("blocks concurrent and restarted replays and commits duplicate expiry extensions", async () => {
  const expiresAt = Date.now() + 60_000;
  await store.mutateAlias({ key: "재전송", value: "AAPL", request: { key: "add", expiresAt } });
  const remove = () => store.mutateAlias({ key: "재전송", request: { key: "remove", expiresAt } });
  const results = await Promise.allSettled([remove(), remove()]);
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const restarted = createSymbolStore(createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_SERVICE_KEY));
  await expect(restarted.mutateAlias({ key: "재전송", value: "MSFT", request: { key: "add", expiresAt: expiresAt + 60_000 } })).rejects.toThrow("이미 처리한");
  expect(await restarted.readAliases()).toEqual([]);
  const record = await admin.from("chart_alias_requests").select("expires_at_ms").eq("request_key", "add").single();
  expect(record.data?.expires_at_ms).toBe(expiresAt + 60_000);
  await expect(restarted.mutateAlias({ key: "만료", value: "AAPL", request: { key: "expired", expiresAt: Date.now() - 1 } })).rejects.toThrow("만료");
  expect(await restarted.readAliases()).toEqual([]);
});

it("treats a request identity as unique across different aliases", async () => {
  const request = { key: "shared-request", expiresAt: Date.now() + 60_000 };
  const results = await Promise.allSettled([
    store.mutateAlias({ key: "후보A", value: "AAPL", request }),
    store.mutateAlias({ key: "후보B", value: "MSFT", request }),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(await store.readAliases()).toHaveLength(1);
});

it("rolls back alias changes if storing the request record fails", async () => {
  const oversizedKey = Array.from({ length: 500 }, () => crypto.randomUUID()).join("");
  await expect(store.mutateAlias({ key: "롤백", value: "AAPL", request: { key: oversizedKey, expiresAt: Date.now() + 60_000 } })).rejects.toThrow("별칭 변경에 실패했습니다");
  expect(await store.readAliases()).toEqual([]);
  const count = await admin.from("chart_alias_requests").select("*", { count: "exact", head: true });
  expect(count.count).toBe(0);
  await store.mutateAlias({ key: "롤백", value: "MSFT", request: { key: "valid", expiresAt: Date.now() + 60_000 } });
  expect(await store.readAliases()).toEqual([{ key: "롤백", value: "MSFT" }]);
});

it("cleans expired request records in bounded batches while retaining active records", async () => {
  await ok(admin.from("chart_alias_requests").insert([
    ...Array.from({ length: 130 }, (_, i) => ({ request_key: `old-${i}`, expires_at_ms: Date.now() - 1000 })),
    { request_key: "active", expires_at_ms: Date.now() + 60_000 },
  ]));
  await store.mutateAlias({ key: "정리", value: "AAPL" });
  expect((await admin.from("chart_alias_requests").select("*", { count: "exact", head: true })).count).toBe(3);
  await store.mutateAlias({ key: "정리", value: "MSFT" });
  expect((await admin.from("chart_alias_requests").select("request_key")).data).toEqual([{ request_key: "active" }]);
});

it("returns a complete ordered snapshot beyond the API's 1000-row limit", async () => {
  await ok(admin.from("chart_aliases").insert(Array.from({ length: 1005 }, (_, i) => ({ alias: `목록${String(i).padStart(4, "0")}`, symbol: "AAPL" }))));
  const aliases = await store.readAliases();
  expect(aliases).toHaveLength(1005);
  expect(aliases[0].key).toBe("목록0000");
  expect(aliases.at(-1)?.key).toBe("목록1004");
  expect(new Set(aliases.map((item) => item.key)).size).toBe(1005);
});

it("distinguishes token lifetime from cache TTL and ignores expired cache rows", async () => {
  const cache = createKisTokenCache(admin);
  expect(await cache.get()).toBeNull();
  const token = { token: "fixture-token", expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
  const before = Date.now();
  await cache.put(token, 82_800);
  expect(await cache.get()).toEqual(token);
  const record = await admin.from("chart_token_cache").select("expires_at_ms").eq("key", KIS_TOKEN_KEY).single();
  expect(record.data?.expires_at_ms).toBeGreaterThanOrEqual(before + 82_800_000);
  await ok(admin.from("chart_token_cache").update({ expires_at_ms: Date.now() - 1 }).eq("key", KIS_TOKEN_KEY));
  expect(await cache.get()).toBeNull();
});

it("denies anonymous and authenticated table, RPC and Storage writes", async () => {
  const anonymous = createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_ANON_KEY);
  const authenticated = createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_ANON_KEY);
  const email = `fixture-${crypto.randomUUID()}@example.invalid`;
  const password = `Fixture-${crypto.randomUUID()}`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error("로컬 인증 사용자 생성에 실패했습니다.");
  let imageKey: string | undefined;
  try {
    const imageUrl = await createImagePublisher(admin).publish(PNG, "https://bot.test/slack");
    imageKey = new URL(imageUrl).pathname.split("/").at(-1)!;
    const signedIn = await authenticated.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw new Error("로컬 인증에 실패했습니다.");
    for (const client of [anonymous, authenticated]) {
      const results = await Promise.all([
        client.from("chart_symbol_catalog").select("*"),
        client.from("chart_aliases").select("*"),
        client.from("chart_token_cache").select("*"),
        client.from("chart_alias_requests").select("*"),
        client.from("chart_aliases").insert({ alias: "차단", symbol: "AAPL" }),
        client.rpc("read_chart_aliases"),
        client.rpc("mutate_chart_alias", { p_key: "차단", p_value: "AAPL" }),
      ]);
      expect(results.map((result) => Boolean(result.error))).toEqual(Array(7).fill(true));
      expect(Boolean((await client.storage.from(CHARTS_BUCKET).upload(`denied-${crypto.randomUUID()}.png`, PNG, { contentType: "image/png" })).error)).toBe(true);
      await client.storage.from(CHARTS_BUCKET).remove([imageKey]);
      const listed = await admin.storage.from(CHARTS_BUCKET).list("", { search: imageKey });
      expect(listed.data?.some((item) => item.name === imageKey)).toBe(true);
    }
    expect(await store.readAliases()).toEqual([]);
  } finally {
    if (imageKey) await admin.storage.from(CHARTS_BUCKET).remove([imageKey]);
    await admin.auth.admin.deleteUser(created.data.user.id);
  }
});

it("serves public PNG bytes while rejecting other MIME types", async () => {
  const url = await createImagePublisher(admin).publish(PNG, "https://bot.test/slack");
  const key = new URL(url).pathname.split("/").at(-1)!;
  try {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toContain("max-age=86400");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
    expect(Boolean((await admin.storage.from(CHARTS_BUCKET).upload("forbidden.html", "<html/>", { contentType: "text/html" })).error)).toBe(true);
  } finally {
    await admin.storage.from(CHARTS_BUCKET).remove([key]);
  }
});
