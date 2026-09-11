import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ALIASES_KEY, resetSymbolCache, SYMBOLS_KEY } from "../src/core/symbols";
import keypair from "./keypair.json" with { type: "json" };

const ENV = env as unknown as Env;
let privateKey: CryptoKey;

beforeAll(async () => {
  privateKey = await crypto.subtle.importKey("jwk", keypair.jwk, { name: "Ed25519" }, false, ["sign"]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSymbolCache();
});

async function signed(body: unknown, opts: { badSig?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(timestamp + raw)));
  if (opts.badSig) sig[0] ^= 0xff;
  const hex = [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://bot.test/discord", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Signature-Ed25519": hex,
      "X-Signature-Timestamp": timestamp,
    },
    body: raw,
  });
}

const yahooBody = {
  chart: {
    result: [
      {
        meta: { exchangeTimezoneName: "Asia/Seoul", currency: "KRW" },
        timestamp: Array.from({ length: 20 }, (_, i) => 1_700_000_000 + i * 86_400),
        indicators: { quote: [{ close: Array.from({ length: 20 }, (_, i) => 70_000 + i * 100) }] },
      },
    ],
  },
};

function stubOutbound(yahooStatus = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("finance.yahoo.com")) {
        return new Response(JSON.stringify(yahooBody), { status: yahooStatus });
      }
      if (url.includes("discord.com/api")) return new Response("{}", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

describe("discord adapter", () => {
  it("rejects non-POST", async () => {
    const res = await worker.fetch(new Request("https://bot.test/discord"), ENV, createExecutionContext());
    expect(res.status).toBe(405);
  });

  it("rejects missing or invalid signatures with 401", async () => {
    const noSig = new Request("https://bot.test/discord", { method: "POST", body: JSON.stringify({ type: 1 }) });
    expect((await worker.fetch(noSig, ENV, createExecutionContext())).status).toBe(401);
    const bad = await signed({ type: 1 }, { badSig: true });
    expect((await worker.fetch(bad, ENV, createExecutionContext())).status).toBe(401);
  });

  it("answers PING with PONG", async () => {
    const res = await worker.fetch(await signed({ type: 1 }), ENV, createExecutionContext());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  it("autocompletes symbols from KV by prefix", async () => {
    await ENV.SYMBOLS.put(
      SYMBOLS_KEY,
      JSON.stringify([
        { key: "삼성전자", value: "005930.KS" },
        { key: "삼성전자우", value: "005935.KS" },
        { key: "카카오", value: "035720.KS" },
      ]),
    );
    const req = await signed({
      type: 4,
      data: { name: "chart", options: [{ name: "ticker", value: "삼성", focused: true }] },
    });
    const res = await worker.fetch(req, ENV, createExecutionContext());
    const body = (await res.json()) as any;
    expect(body.type).toBe(8);
    expect(body.data.choices.map((c: any) => c.value)).toEqual(["005930.KS", "005935.KS"]);
  });

  it("keeps KV autocomplete hits when the remote search returns garbage", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "SAMSUNG", value: "005930.KS" }]));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>consent</html>", { status: 200 })));
    const req = await signed({ type: 4, data: { name: "chart", options: [{ name: "ticker", value: "sa", focused: true }] } });
    const res = await worker.fetch(req, ENV, createExecutionContext());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.choices.map((c: any) => c.value)).toEqual(["005930.KS"]);
  });

  it("defers /chart, resolves the alias, renders a PNG and patches the original message", async () => {
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "삼성전자", value: "005930.KS" }]));
    const calls = stubOutbound();
    const ctx = createExecutionContext();
    const req = await signed({
      type: 2,
      token: "interaction-token",
      data: { name: "chart", options: [{ name: "ticker", value: "삼성전자" }, { name: "range", value: "1m" }] },
    });
    const res = await worker.fetch(req, ENV, ctx);
    expect(await res.json()).toEqual({ type: 5 });
    await waitOnExecutionContext(ctx);

    const yahoo = calls.find((c) => c.url.includes("finance.yahoo.com"))!;
    expect(new URL(yahoo.url).pathname).toBe("/v8/finance/chart/005930.KS");
    expect(new URL(yahoo.url).searchParams.get("range")).toBe("1mo");

    const patch = calls.find((c) => c.url.includes("discord.com/api"))!;
    expect(patch.url).toBe(`https://discord.com/api/v10/webhooks/${ENV.DISCORD_APPLICATION_ID}/interaction-token/messages/@original`);
    expect(patch.init?.method).toBe("PATCH");
    const form = patch.init?.body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.content).toBe("**삼성전자 (005930.KS)** 1m · 71,900 KRW ▲ +1,900 (+2.71%)");
    expect(payload.embeds[0].color).toBe(0xdc2626);
    expect(payload.embeds[0].footer.text).toBe("출처: Yahoo Finance");
    const file = form.get("files[0]") as File;
    expect(file.name).toBe("chart.png");
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(bytes.length).toBeGreaterThan(5000);
  });

  it("reports upstream failures back to the user in Korean", async () => {
    const calls = stubOutbound(500);
    const ctx = createExecutionContext();
    const req = await signed({ type: 2, token: "tok", data: { name: "chart", options: [{ name: "ticker", value: "AAPL" }] } });
    await worker.fetch(req, ENV, ctx);
    await waitOnExecutionContext(ctx);
    const patch = calls.find((c) => c.url.includes("discord.com/api"))!;
    expect(JSON.parse(patch.init?.body as string).content).toContain("시세 조회 실패 (500)");
  });

  it("rejects /alias add from members without manage-guild permission", async () => {
    const calls = stubOutbound();
    const req = await signed({
      type: 2,
      token: "tok",
      member: { permissions: String(1 << 11) },
      data: { name: "alias", options: [{ type: 1, name: "add", options: [{ name: "alias", value: "하닉" }, { name: "target", value: "SK하이닉스" }] }] },
    });
    const res = await worker.fetch(req, ENV, createExecutionContext());
    const body = (await res.json()) as any;
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("권한");
    expect(calls).toHaveLength(0);
  });

  it("lets managers add and remove aliases and autocompletes them", async () => {
    await ENV.SYMBOLS.delete(ALIASES_KEY);
    await ENV.SYMBOLS.put(SYMBOLS_KEY, JSON.stringify([{ key: "SK하이닉스", value: "000660.KS" }]));
    const calls = stubOutbound();
    const manager = { permissions: String(1 << 5) };

    let ctx = createExecutionContext();
    let req = await signed({
      type: 2,
      token: "tok",
      member: manager,
      data: { name: "alias", options: [{ type: 1, name: "add", options: [{ name: "alias", value: "하닉" }, { name: "target", value: "SK하이닉스" }] }] },
    });
    expect(await (await worker.fetch(req, ENV, ctx)).json()).toEqual({ type: 5 });
    await waitOnExecutionContext(ctx);
    expect(JSON.parse(calls.at(-1)!.init?.body as string).content).toBe("✅ 별칭 추가: 하닉 → SK하이닉스 (000660.KS)");
    expect(await ENV.SYMBOLS.get(ALIASES_KEY, "json")).toEqual([{ key: "하닉", value: "000660.KS" }]);

    req = await signed({
      type: 4,
      data: { name: "alias", options: [{ type: 1, name: "remove", options: [{ name: "alias", value: "하", focused: true }] }] },
    });
    const ac = (await (await worker.fetch(req, ENV, createExecutionContext())).json()) as any;
    expect(ac.data.choices).toEqual([{ name: "하닉 → SK하이닉스 (000660.KS)", value: "하닉" }]);

    req = await signed({
      type: 4,
      data: { name: "alias", options: [{ type: 1, name: "add", options: [{ name: "alias", value: "x" }, { name: "target", value: "sk하", focused: true }] }] },
    });
    const ac2 = (await (await worker.fetch(req, ENV, createExecutionContext())).json()) as any;
    expect(ac2.data.choices.map((c: any) => c.value)).toEqual(["000660.KS"]);

    ctx = createExecutionContext();
    req = await signed({ type: 2, token: "tok", member: { permissions: "0" }, data: { name: "alias", options: [{ type: 1, name: "list" }] } });
    expect(await (await worker.fetch(req, ENV, ctx)).json()).toEqual({ type: 5 });
    await waitOnExecutionContext(ctx);
    expect(JSON.parse(calls.at(-1)!.init?.body as string).content).toBe("• 하닉 → SK하이닉스 (000660.KS)");

    ctx = createExecutionContext();
    req = await signed({ type: 2, token: "tok", member: manager, data: { name: "alias", options: [{ type: 1, name: "remove", options: [{ name: "alias", value: "하닉" }] }] } });
    await worker.fetch(req, ENV, ctx);
    await waitOnExecutionContext(ctx);
    expect(JSON.parse(calls.at(-1)!.init?.body as string).content).toContain("별칭 삭제");
    expect(await ENV.SYMBOLS.get(ALIASES_KEY, "json")).toEqual([]);
  });

  it("reports validation errors without calling upstream", async () => {
    const calls = stubOutbound();
    const ctx = createExecutionContext();
    const req = await signed({ type: 2, token: "tok", data: { name: "chart", options: [{ name: "ticker", value: "AAPL" }, { name: "from", value: "2024-01-01" }] } });
    await worker.fetch(req, ENV, ctx);
    await waitOnExecutionContext(ctx);
    expect(calls.some((c) => c.url.includes("yahoo"))).toBe(false);
    const patch = calls.find((c) => c.url.includes("discord.com/api"))!;
    expect(JSON.parse(patch.init?.body as string).content).toContain("함께");
  });
});
