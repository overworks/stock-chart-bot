import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { BotConfig } from "../src/config";
import type { BotServices, TraceSpan } from "../src/core/runtime";
import { runChart } from "../src/core/run";
import keypair from "./keypair.json" with { type: "json" };

const CONFIG: BotConfig = {
  discordPublicKey: keypair.publicHex,
  discordApplicationId: "app-test",
  slackSigningSecret: "secret",
};
const PNG = new Uint8Array([137, 80, 78, 71]);

function services(): BotServices {
  return {
    symbols: { readSeed: async () => [], readAliases: async () => [], mutateAlias: vi.fn() },
    providers: [{
      name: "fixture",
      getPrices: async () => ({ bars: [{ t: 1, c: 100 }, { t: 2, c: 101 }], label: "1m", currency: "USD", intraday: false, timeZone: "UTC", source: "fixture" }),
      search: async () => [],
    }],
    render: vi.fn(async () => PNG),
    images: { publish: vi.fn(async () => "https://images.test/storage/chart.png") },
  };
}

async function slack(command: string, text = "AAPL 1m") {
  const body = new URLSearchParams({ command, text, response_url: "https://hooks.test/response" }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(CONFIG.slackSigningSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return new Request("https://bot.test/slack", {
    method: "POST", body,
    headers: { "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${[...signature].map((b) => b.toString(16).padStart(2, "0")).join("")}` },
  });
}

async function discord() {
  const body = JSON.stringify({ type: 2, token: "fixture", data: { name: "stock-chart", options: [{ name: "ticker", value: "AAPL" }, { name: "range", value: "1m" }] } });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("jwk", keypair.jwk, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(timestamp + body)));
  return new Request("https://bot.test/discord", {
    method: "POST", body,
    headers: { "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": [...signature].map((b) => b.toString(16).padStart(2, "0")).join("") },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("serves signed help with no storage, rendering, image publication or background work", async () => {
  const runtime = services();
  runtime.symbols.readSeed = vi.fn(async () => { throw new Error("unexpected storage"); });
  const tasks = { waitUntil: vi.fn() };
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const response = await createApp(CONFIG, runtime).fetch(await slack("/stock-help"), tasks);
  expect((await response.json() as { response_type: string }).response_type).toBe("ephemeral");
  expect(runtime.symbols.readSeed).not.toHaveBeenCalled();
  expect(runtime.render).not.toHaveBeenCalled();
  expect(runtime.images.publish).not.toHaveBeenCalled();
  expect(tasks.waitUntil).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["slack", "discord"])("acknowledges %s before rendering finishes and delivers through injected services", async (platform) => {
  const runtime = services();
  let complete!: (png: Uint8Array) => void;
  runtime.render = vi.fn(() => new Promise<Uint8Array>((resolve) => { complete = resolve; }));
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit) => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  const work: Promise<unknown>[] = [];
  const request = platform === "slack" ? await slack("/stock-chart") : await discord();
  const response = await createApp(CONFIG, runtime).fetch(request, { waitUntil: (task) => { work.push(task); } });
  const body = await response.json() as { type?: number; response_type?: string };
  expect(platform === "slack" ? body.response_type : body.type).toBe(platform === "slack" ? "ephemeral" : 5);
  expect(work).toHaveLength(1);
  await vi.waitFor(() => expect(runtime.render).toHaveBeenCalledOnce());
  expect(fetch).not.toHaveBeenCalled();
  complete(PNG);
  await Promise.all(work);
  if (platform === "slack") {
    expect(runtime.images.publish).toHaveBeenCalledWith(PNG, request.url);
    const payload = JSON.parse(fetch.mock.calls[0][1].body as string);
    expect(payload.blocks[1].image_url).toBe("https://images.test/storage/chart.png");
  } else {
    expect(runtime.images.publish).not.toHaveBeenCalled();
    const file = (fetch.mock.calls[0][1].body as FormData).get("files[0]") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(PNG);
  }
});

it("delegates image serving when supplied and handles missing routes without a platform store", async () => {
  const runtime = services();
  const tasks = { waitUntil: vi.fn() };
  expect((await createApp(CONFIG, runtime).fetch(new Request("https://bot.test/charts/a.png"), tasks)).status).toBe(404);
  runtime.serveImage = vi.fn(async () => new Response(PNG, { headers: { "content-type": "image/png" } }));
  const app = createApp(CONFIG, runtime);
  expect((await app.fetch(new Request("https://bot.test/charts/a.png"), tasks)).headers.get("content-type")).toBe("image/png");
  expect(runtime.serveImage).toHaveBeenCalledWith("/charts/a.png");
  expect((await app.fetch(new Request("https://bot.test/charts/a.png", { method: "POST" }), tasks)).status).toBe(404);
  expect(runtime.serveImage).toHaveBeenCalledTimes(1);
});

it("records the existing chart spans and attributes through an injected tracer", async () => {
  const runtime = services();
  const spans: { name: string; attributes: Record<string, unknown> }[] = [];
  runtime.tracer = {
    async enterSpan<T>(name: string, work: (span: TraceSpan) => Promise<T>) {
      const entry = { name, attributes: {} };
      spans.push(entry);
      return work({ setAttributes: (attributes) => { Object.assign(entry.attributes, attributes); } });
    },
  };
  await runChart({ ticker: "AAPL", range: "1m" }, runtime.symbols, runtime.providers, runtime);
  expect(spans.map((entry) => entry.name)).toEqual(["chart", "chart.resolve", "chart.prices", "chart.render"]);
  expect(spans[0].attributes).toMatchObject({ "chart.ticker": "AAPL", "chart.symbol": "AAPL", "chart.source": "fixture" });
});
