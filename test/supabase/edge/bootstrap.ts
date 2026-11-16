import { serverKey } from "../../../supabase/functions/stock-chart-bot/config.ts";

const nativeFetch = globalThis.fetch;
const backend = Deno.env.get("SUPABASE_URL")!;
const key = serverKey((name) => Deno.env.get(name));

async function collect(request: Request, kind: string): Promise<Response> {
  let payload: unknown;
  let pngBase64: string | undefined;
  let mime: string | undefined;
  let filename: string | undefined;
  if (request.headers.get("content-type")?.startsWith("multipart/form-data")) {
    const form = await request.formData();
    payload = JSON.parse(String(form.get("payload_json")));
    const file = form.get("files[0]");
    if (file instanceof File) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      pngBase64 = btoa(binary);
      mime = file.type;
      filename = file.name;
    }
  } else payload = await request.json();
  const response = await nativeFetch(`${backend}/rest/v1/chart_test_deliveries`, {
    method: "POST",
    headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ kind, payload, png_base64: pngBase64, mime, filename, deno_version: Deno.version.deno }),
  });
  if (!response.ok) throw new Error("로컬 결과 수집에 실패했습니다.");
  return Response.json({});
}

globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === new URL(backend).origin) return nativeFetch(request);
  if (url.hostname === "query1.finance.yahoo.com" && url.pathname.includes("/chart/")) {
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const symbol = decodeURIComponent(url.pathname.split("/").at(-1)!);
    const count = symbol === "LONG" ? 2000 : 30;
    return Response.json({ chart: { result: [{
      meta: { exchangeTimezoneName: "Asia/Seoul", currency: "KRW", shortName: "한글 종목" },
      timestamp: Array.from({ length: count }, (_, index) => 1_700_000_000 + index * 86_400),
      indicators: { quote: [{
        open: Array.from({ length: count }, (_, index) => 100 + index),
        high: Array.from({ length: count }, (_, index) => 110 + index),
        low: Array.from({ length: count }, (_, index) => 90 + index),
        close: Array.from({ length: count }, (_, index) => 105 + index),
        volume: Array.from({ length: count }, () => 1000),
      }] },
    }] } });
  }
  if (url.hostname === "query1.finance.yahoo.com" && url.pathname.includes("/search")) return Response.json({ quotes: [] });
  if (url.hostname === "discord.com" && url.pathname.startsWith("/api/v10/webhooks/")) return collect(request, "discord");
  if (url.hostname === "hooks.slack.test") return collect(request, "slack");
  throw new Error("검증 중 외부 네트워크 요청을 차단했습니다.");
};

await import("../../../supabase/functions/stock-chart-bot/index.ts");
