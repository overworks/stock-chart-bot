import { env } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import keypair from "../keypair.json" with { type: "json" };
import { SYMBOLS_KEY, createChartClient } from "../../supabase/functions/stock-chart-bot/adapters.ts";

const local = env as unknown as { SUPABASE_TEST_URL: string; SUPABASE_TEST_SERVICE_KEY: string };
const admin = createChartClient(local.SUPABASE_TEST_URL, local.SUPABASE_TEST_SERVICE_KEY);
const url = (path: string) => `${local.SUPABASE_TEST_URL}/functions/v1/stock-chart-bot${path}`;
const headers = { apikey: local.SUPABASE_TEST_SERVICE_KEY, authorization: `Bearer ${local.SUPABASE_TEST_SERVICE_KEY}`, "content-type": "application/json" };

interface Delivery {
  kind: string;
  payload: { content?: string; text?: string; response_type?: string; blocks?: { type: string; image_url?: string }[] };
  png_base64: string | null;
  mime: string | null;
  filename: string | null;
  deno_version: string;
}

async function clearDeliveries(): Promise<void> {
  const response = await fetch(`${local.SUPABASE_TEST_URL}/rest/v1/chart_test_deliveries?id=gte.0`, { method: "DELETE", headers });
  if (!response.ok) throw new Error("로컬 전송 기록 초기화에 실패했습니다.");
}

async function delivered(kind: string): Promise<Delivery> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${local.SUPABASE_TEST_URL}/rest/v1/chart_test_deliveries?kind=eq.${kind}&order=id.desc&limit=1`, { headers });
    if (!response.ok) throw new Error("로컬 전송 기록 조회에 실패했습니다.");
    const rows = await response.json() as Delivery[];
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Edge Runtime 결과 전송이 완료되지 않았습니다.");
}

function png(bytes: Uint8Array): void {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16)).toBe(960);
}

async function discord(data: unknown, id = crypto.randomUUID()): Promise<Request> {
  const body = JSON.stringify({ type: 2, token: "fixture", id, ...data as object });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("jwk", keypair.jwk, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(timestamp + body)));
  return new Request(url("/discord"), { method: "POST", body, headers: {
    "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": [...signature].map((value) => value.toString(16).padStart(2, "0")).join(""),
  } });
}

async function slack(command: string, text = "", secret = "local-edge-slack-secret"): Promise<Request> {
  const body = new URLSearchParams({ command, text, user_id: "U_ADMIN", response_url: "https://hooks.slack.test/response" }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return new Request(url("/slack"), { method: "POST", body, headers: {
    "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": `v0=${[...signature].map((value) => value.toString(16).padStart(2, "0")).join("")}`,
  } });
}

beforeEach(async () => {
  await clearDeliveries();
  const result = await admin.from("chart_symbol_catalog").upsert({ id: SYMBOLS_KEY, entries: [
    { key: "삼성전자", value: "005930.KS" }, { key: "긴 한글 종목", value: "LONG" },
  ] });
  if (result.error) throw new Error("Edge Runtime 검증 종목 초기화에 실패했습니다.");
});

it("accepts signed help without a Supabase JWT and rejects invalid messenger signatures", async () => {
  const discordHelp = await fetch(await discord({ data: { name: "stock-help" } }));
  expect((await discordHelp.json() as { type: number }).type).toBe(4);
  const slackHelp = await fetch(await slack("/stock-help"));
  expect((await slackHelp.json() as { response_type: string }).response_type).toBe("ephemeral");
  const invalid = await fetch(await slack("/stock-help", "", "wrong-secret"));
  expect(invalid.status).toBe(401);
  expect(await invalid.text()).toBe("invalid request signature");
  expect((await fetch(url("/missing"))).status).toBe(404);
});

it("returns database-backed Korean autocomplete within the initial response deadline", async () => {
  const request = await discord({ type: 4, data: { name: "stock-chart", options: [{ name: "ticker", value: "삼성", focused: true }] } });
  const start = Date.now();
  const response = await fetch(request);
  const body = await response.json() as { type: number; data: { choices: { name: string; value: string }[] } };
  expect(body.type).toBe(8);
  expect(body.data.choices).toEqual([{ name: "삼성전자 (005930.KS)", value: "005930.KS" }]);
  expect(Date.now() - start).toBeLessThan(3000);
});

it("acknowledges Discord before delayed prices and delivers a real Korean PNG after the response", async () => {
  const request = await discord({ data: { name: "stock-chart", options: [
    { name: "ticker", value: "삼성전자" }, { name: "range", value: "1m" }, { name: "style", value: "candle" }, { name: "volume", value: true },
  ] } });
  const start = Date.now();
  const response = await fetch(request);
  expect((await response.json() as { type: number }).type).toBe(5);
  expect(Date.now() - start).toBeLessThan(3000);
  const delivery = await delivered("discord");
  expect(delivery.payload.content).toContain("삼성전자");
  expect(delivery.mime).toBe("image/png");
  expect(delivery.filename).toBe("chart.png");
  expect(delivery.deno_version).toMatch(/\d+\.\d+\.\d+/);
  png(Uint8Array.from(atob(delivery.png_base64!), (value) => value.charCodeAt(0)));
});

it("publishes Slack images through Storage across repeated line and candle renders", async () => {
  for (const text of ["삼성전자 1m", "삼성전자 1m candle volume"]) {
    await clearDeliveries();
    const start = Date.now();
    const response = await fetch(await slack("/stock-chart", text));
    expect((await response.json() as { response_type: string }).response_type).toBe("ephemeral");
    expect(Date.now() - start).toBeLessThan(3000);
    const delivery = await delivered("slack");
    expect(delivery.payload.text).toContain("삼성전자");
    const imageUrl = delivery.payload.blocks?.find((block) => block.type === "image")?.image_url;
    expect(imageUrl).toBeDefined();
    const image = await fetch(new URL(new URL(imageUrl!).pathname, local.SUPABASE_TEST_URL));
    expect(image.headers.get("content-type")).toBe("image/png");
    png(new Uint8Array(await image.arrayBuffer()));
  }
});

it("applies native alias mutations, replay protection and both platforms' permissions", async () => {
  const request = await discord({ member: { permissions: "8" }, data: { name: "stock-alias", options: [{ type: 1, name: "add", options: [
    { name: "alias", value: "로컬별칭" }, { name: "target", value: "삼성전자" },
  ] }] } });
  expect((await (await fetch(request.clone())).json() as { type: number }).type).toBe(5);
  expect((await delivered("discord")).payload.content).toContain("별칭 추가");
  await clearDeliveries();
  expect((await (await fetch(request.clone())).json() as { type: number }).type).toBe(5);
  expect((await delivered("discord")).payload.content).toContain("이미 처리한");
  const forbidden = await fetch(await discord({ member: { permissions: "0" }, data: { name: "stock-alias", options: [{ type: 1, name: "remove", options: [{ name: "alias", value: "로컬별칭" }] }] } }));
  expect((await forbidden.json() as { type: number }).type).toBe(4);
  await clearDeliveries();
  expect((await fetch(await slack("/stock-alias", "add 슬랙별칭 삼성전자"))).status).toBe(200);
  expect((await delivered("slack")).payload.text).toContain("별칭 추가");
  const aliases = await admin.rpc("read_chart_aliases");
  expect(aliases.data).toEqual(expect.arrayContaining([{ key: "로컬별칭", value: "005930.KS" }, { key: "슬랙별칭", value: "005930.KS" }]));
});
