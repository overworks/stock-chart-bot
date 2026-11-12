import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { AliasWriter } from "../src/core/alias-writer";
import { ALIASES_KEY } from "../src/core/symbols";
import { captureLogs } from "./logs";

afterEach(() => vi.restoreAllMocks());

it("recovers durable aliases after a failed KV write and a new instance", async () => {
  const namespace = (env as unknown as Env).ALIAS_WRITER;
  const stub = namespace.get(namespace.newUniqueId());
  const logs = captureLogs();
  await runInDurableObject(stub, async (_, state) => {
    const get = vi.fn().mockResolvedValue([{ key: "기존", value: "AAPL" }]);
    const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const bindings = { ...env, KV: { get, put } } as unknown as Env;
    const writer = new AliasWriter(state, bindings);
    const response = await writer.fetch(new Request("https://aliases/mutate", {
      method: "POST", body: JSON.stringify({ key: "추가", value: "MSFT" }),
    }));
    expect(response.status).toBe(503);
    expect(logs("chart.alias.publish_deferred")).toEqual([{ level: "warn", message: "chart.alias.publish_deferred", "exception.type": "Error", "exception.message": "KV unavailable" }]);
    const expected = [{ key: "기존", value: "AAPL" }, { key: "추가", value: "MSFT" }];
    expect(await state.storage.get(ALIASES_KEY)).toEqual(expected);
    expect(await state.storage.getAlarm()).not.toBeNull();

    put.mockResolvedValue(undefined);
    const restarted = new AliasWriter(state, bindings);
    await restarted.alarm();
    expect(JSON.parse(put.mock.calls.at(-1)![1])).toEqual(expected);
    expect(await state.storage.getAlarm()).toBeNull();

    await restarted.fetch(new Request("https://aliases/mutate", {
      method: "POST", body: JSON.stringify({ key: "후속", value: "GOOG" }),
    }));
    expect(JSON.parse(put.mock.calls.at(-1)![1])).toEqual([...expected, { key: "후속", value: "GOOG" }]);
    expect(get).toHaveBeenCalledTimes(1);
  });
  vi.restoreAllMocks();
});

it("blocks concurrent and restarted replays without restoring a removed alias", async () => {
  const namespace = (env as unknown as Env).ALIAS_WRITER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_, state) => {
    const put = vi.fn().mockResolvedValue(undefined);
    const bindings = { KV: { get: async () => [], put } } as unknown as Env;
    const writer = new AliasWriter(state, bindings);
    const expiresAt = Date.now() + 60_000;
    const request = (key: string, value?: string, expiry = expiresAt) => new Request("https://aliases/mutate", {
      method: "POST", body: JSON.stringify({ key: "별칭", value, request: { key, expiresAt: expiry } }),
    });
    expect((await writer.fetch(request("add", "AAPL"))).status).toBe(200);
    const removed = await Promise.all([writer.fetch(request("remove")), writer.fetch(request("remove"))]);
    expect(removed.map((res) => res.status)).toEqual([200, 409]);
    const restarted = new AliasWriter(state, bindings);
    expect((await restarted.fetch(request("add", "AAPL"))).status).toBe(409);
    expect(await state.storage.get(ALIASES_KEY)).toEqual([]);
    expect(put).toHaveBeenCalledTimes(2);
    expect(await state.storage.getAlarm()).toBe(expiresAt);
    expect((await restarted.fetch(request("add", "AAPL", expiresAt + 60_000))).status).toBe(409);
    await restarted.alarm();
    expect(await state.storage.getAlarm()).toBe(expiresAt + 60_000);
    expect(put).toHaveBeenCalledTimes(2);
  });
});

it("expires request records in batches without republishing aliases", async () => {
  const namespace = (env as unknown as Env).ALIAS_WRITER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_, state) => {
    const put = vi.fn();
    const writer = new AliasWriter(state, { KV: { put } } as unknown as Env);
    await state.storage.put("publishPending", false);
    for (let i = 0; i < 129; i++) await state.storage.put(`request:old-${i}`, Date.now() - 1000);
    const expiresAt = Date.now() + 60_000;
    await state.storage.put("request:recent", expiresAt);
    await writer.alarm();
    expect(await state.storage.list({ prefix: "request:" })).toEqual(new Map([["request:recent", expiresAt]]));
    expect(await state.storage.getAlarm()).toBe(expiresAt);
    await state.storage.put("request:recent", Date.now() - 1000);
    await writer.alarm();
    expect(await state.storage.getAlarm()).toBeNull();
    expect(put).not.toHaveBeenCalled();
    const expired = await writer.fetch(new Request("https://aliases/mutate", {
      method: "POST", body: JSON.stringify({ key: "별칭", value: "AAPL", request: { key: "expired", expiresAt: Date.now() - 1000 } }),
    }));
    expect(expired.status).toBe(408);
    expect(await state.storage.get(ALIASES_KEY)).toBeUndefined();
  });
});
