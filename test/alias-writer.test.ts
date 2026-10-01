import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import { AliasWriter } from "../src/core/alias-writer";
import { ALIASES_KEY } from "../src/core/symbols";

it("recovers durable aliases after a failed KV write and a new instance", async () => {
  const namespace = (env as unknown as Env).ALIAS_WRITER;
  const stub = namespace.get(namespace.newUniqueId());
  await runInDurableObject(stub, async (_, state) => {
    const get = vi.fn().mockResolvedValue([{ key: "기존", value: "AAPL" }]);
    const put = vi.fn().mockRejectedValue(new Error("KV unavailable"));
    const bindings = { ...env, SYMBOLS: { get, put } } as unknown as Env;
    const writer = new AliasWriter(state, bindings);
    const response = await writer.fetch(new Request("https://aliases/mutate", {
      method: "POST", body: JSON.stringify({ key: "추가", value: "MSFT" }),
    }));
    expect(response.status).toBe(503);
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
});
