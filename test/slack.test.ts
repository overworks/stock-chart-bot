import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseAliasText, parseText } from "../src/platforms/slack";
import { ALIASES_KEY, resetSymbolCache, SYMBOLS_KEY } from "../src/core/symbols";

const ENV = env as unknown as Env;
const SECRET = "test-signing-secret";

afterEach(() => {
  vi.unstubAllGlobals();
  resetSymbolCache();
});

async function sign(body: string, ts: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${ts}:${body}`)));
  return `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

async function slash(fields: Record<string, string>, opts: { ts?: string; secret?: string } = {}) {
  const body = new URLSearchParams({ command: "/stock-chart", response_url: "https://hooks.slack.test/resp", user_id: "U_USER", ...fields }).toString();
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  return new Request("https://bot.test/slack", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "X-Slack-Signature": await sign(body, ts, opts.secret),
      "X-Slack-Request-Timestamp": ts,
    },
    body,
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
      if (url.includes("finance.yahoo.com")) return new Response(JSON.stringify(yahooBody), { status: yahooStatus });
      if (url.startsWith("https://hooks.slack.test/")) return new Response("ok");
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

describe("parseText", () => {
  it("takes the first token as ticker, then options in any order", () => {
    expect(parseText("삼성전자")).toEqual({ ticker: "삼성전자" });
    expect(parseText("AAPL 1m candle")).toEqual({ ticker: "AAPL", range: "1m", style: "candle" });
    expect(parseText("sk candle 3M 하이닉스")).toEqual({ ticker: "sk 하이닉스", range: "3m", style: "candle" });
    expect(parseText("AAPL 2024-01-01 2024-06-30")).toEqual({ ticker: "AAPL", from: "2024-01-01", to: "2024-06-30" });
    expect(parseText("   ")).toEqual({ ticker: "" });
  });

  it("lets keyword-like tickers through and unescapes Slack HTML entities", () => {
    expect(parseText("MAX")).toEqual({ ticker: "MAX" });
    expect(parseText("max 1m")).toEqual({ ticker: "max", range: "1m" });
    expect(parseText("S&amp;P500 1y")).toEqual({ ticker: "S&P500", range: "1y" });
    expect(parseText("삼성E&amp;A")).toEqual({ ticker: "삼성E&A" });
  });
});

describe("parseAliasText", () => {
  it("parses add/remove/list and joins multi-word targets", () => {
    expect(parseAliasText("add 삼전 삼성전자")).toEqual({ action: "add", alias: "삼전", target: "삼성전자" });
    expect(parseAliasText("ADD 하닉 sk 하이닉스")).toEqual({ action: "add", alias: "하닉", target: "sk 하이닉스" });
    expect(parseAliasText("remove 삼전")).toEqual({ action: "remove", alias: "삼전" });
    expect(parseAliasText("list")).toEqual({ action: "list" });
    expect(parseAliasText("add 삼전")).toEqual({});
    expect(parseAliasText("")).toEqual({});
  });
});

describe("slack alias commands", () => {
  it.each(["/stock-alias", "/alias"])("shows usage, lets anyone list, and blocks non-admins from changes via %s", async (command) => {
    await ENV.KV.delete(ALIASES_KEY);
    const calls = stubOutbound();
    const usage = (await (await worker.fetch(await slash({ command, text: "add" }), ENV, createExecutionContext())).json()) as any;
    expect(usage.text).toContain("/stock-alias add");
    const list = (await (await worker.fetch(await slash({ command, text: "list" }), ENV, createExecutionContext())).json()) as any;
    expect(list).toEqual({ response_type: "ephemeral", text: "등록된 별칭이 없습니다." });
    for (const text of ["add 하닉 SK하이닉스", "remove 하닉"]) {
      const denied = (await (await worker.fetch(await slash({ command, text }), ENV, createExecutionContext())).json()) as any;
      expect(denied.text).toContain("권한");
    }
    expect(calls).toHaveLength(0);
  });

  it.each([["/stock-alias", "/alias"], ["/alias", "/stock-alias"]])("adds with %s, then lists and removes with %s", async (command, otherCommand) => {
    await ENV.KV.delete(ALIASES_KEY);
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "SK하이닉스", value: "000660.KS" }]));
    const calls = stubOutbound();
    const ctx = createExecutionContext();
    const res = await worker.fetch(await slash({ command, text: "add 하닉 SK하이닉스", user_id: "U_OTHER" }), ENV, ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    await waitOnExecutionContext(ctx);
    const hook = calls.find((c) => c.url.startsWith("https://hooks.slack.test/"))!;
    expect(JSON.parse(hook.init?.body as string)).toEqual({ response_type: "in_channel", text: "✅ 별칭 추가: 하닉 → SK하이닉스 (000660.KS)" });
    expect(await ENV.KV.get(ALIASES_KEY, "json")).toEqual([{ key: "하닉", value: "000660.KS" }]);

    const list = await worker.fetch(await slash({ command: otherCommand, text: "list" }), ENV, createExecutionContext());
    expect(await list.json()).toEqual({ response_type: "ephemeral", text: "• 하닉 → SK하이닉스 (000660.KS)" });

    const removeCtx = createExecutionContext();
    const removed = await worker.fetch(await slash({ command: otherCommand, text: "remove 하닉", user_id: "U_OTHER" }), ENV, removeCtx);
    expect(removed.status).toBe(200);
    expect(await removed.text()).toBe("");
    await waitOnExecutionContext(removeCtx);
    expect(JSON.parse(calls.at(-1)!.init?.body as string)).toEqual({ response_type: "in_channel", text: "🗑️ 별칭 삭제: 하닉 → 000660.KS" });
    expect(await ENV.KV.get(ALIASES_KEY, "json")).toEqual([]);
  });
});

describe("slack adapter", () => {
  it("rejects non-POST and bad or stale signatures", async () => {
    expect((await worker.fetch(new Request("https://bot.test/slack"), ENV, createExecutionContext())).status).toBe(405);
    const bad = await slash({ text: "AAPL" }, { secret: "wrong" });
    expect((await worker.fetch(bad, ENV, createExecutionContext())).status).toBe(401);
    const stale = await slash({ text: "AAPL" }, { ts: String(Math.floor(Date.now() / 1000) - 600) });
    expect((await worker.fetch(stale, ENV, createExecutionContext())).status).toBe(401);
    const noSig = new Request("https://bot.test/slack", { method: "POST", body: "text=AAPL" });
    expect((await worker.fetch(noSig, ENV, createExecutionContext())).status).toBe(401);
  });

  it("returns 401 instead of crashing when the signing secret is unset", async () => {
    const req = await slash({ text: "AAPL" });
    const res = await worker.fetch(req, { ...ENV, SLACK_SIGNING_SECRET: undefined as unknown as string }, createExecutionContext());
    expect(res.status).toBe(401);
  });

  it.each(["/stock-chart", "/chart"])("replies with usage when no ticker is given for %s", async (command) => {
    const res = await worker.fetch(await slash({ command, text: "" }), ENV, createExecutionContext());
    const body = (await res.json()) as any;
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("/stock-chart <종목>");
  });

  it.each(["/stock-chart", "/chart"])("acks %s, stores the PNG in R2, posts an image block, and serves the image", async (command) => {
    await ENV.KV.put(SYMBOLS_KEY, JSON.stringify([{ key: "삼성전자", value: "005930.KS" }]));
    const calls = stubOutbound();
    const ctx = createExecutionContext();
    const res = await worker.fetch(await slash({ command, text: "삼성전자 1m" }), ENV, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).response_type).toBe("ephemeral");
    await waitOnExecutionContext(ctx);

    const hook = calls.find((c) => c.url.startsWith("https://hooks.slack.test/"))!;
    const payload = JSON.parse(hook.init?.body as string);
    expect(payload.response_type).toBe("in_channel");
    expect(payload.text).toBe("삼성전자 (005930.KS) 1m · 71,900 KRW ▲ +1,900 (+2.71%)");
    expect(payload.blocks[0].text.text).toBe("*삼성전자 (005930.KS)* 1m · 71,900 KRW ▲ +1,900 (+2.71%)");
    const imageUrl: string = payload.blocks[1].image_url;
    expect(imageUrl).toMatch(/^https:\/\/bot\.test\/charts\/[a-z0-9]+-[0-9a-f-]+\.png$/);

    const img = await worker.fetch(new Request(imageUrl), ENV, createExecutionContext());
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await img.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it.each(["/stock-chart", "/chart"])("reports %s failures as an ephemeral message", async (command) => {
    const calls = stubOutbound(500);
    const ctx = createExecutionContext();
    await worker.fetch(await slash({ command, text: "AAPL" }), ENV, ctx);
    await waitOnExecutionContext(ctx);
    const hook = calls.find((c) => c.url.startsWith("https://hooks.slack.test/"))!;
    const payload = JSON.parse(hook.init?.body as string);
    expect(payload.response_type).toBe("ephemeral");
    expect(payload.text).toContain("시세 조회 실패 (500)");
  });
});

describe("chart route", () => {
  it("404s for unknown or malformed keys", async () => {
    for (const p of ["/charts/nope.png", "/charts/a.txt", "/charts/", "/nope"]) {
      const res = await worker.fetch(new Request(`https://bot.test${p}`), ENV, createExecutionContext());
      expect(res.status).toBe(404);
    }
  });
});
