import { RANGE_CHOICES, STYLE_CHOICES } from "../core/command";
import { runChart } from "../core/run";
import { storeChart } from "../core/store";

const TOLERANCE_SEC = 5 * 60;
const USAGE =
  "사용법: `/chart <종목> [1d|1w|1m|3m|6m|1y|5y|max] [candle]` 또는 `/chart <종목> <YYYY-MM-DD> <YYYY-MM-DD> [candle]`";

export async function handleSlack(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST") return new Response("", { status: 405 });

  const body = await req.text();
  const signature = req.headers.get("X-Slack-Signature");
  const timestamp = req.headers.get("X-Slack-Request-Timestamp");
  if (!signature || !timestamp || !(await verifySlack(body, signature, timestamp, env.SLACK_SIGNING_SECRET))) {
    return new Response("invalid request signature", { status: 401 });
  }

  const form = new URLSearchParams(body);
  const responseUrl = form.get("response_url") ?? "";
  const args = parseText(form.get("text") ?? "");
  if (!args.ticker || !responseUrl) return ephemeral(USAGE);

  const origin = new URL(req.url).origin;
  ctx.waitUntil(serveChart(responseUrl, origin, args, env));
  return ephemeral("차트를 만드는 중입니다…");
}

export function parseText(text: string): Record<string, string | undefined> {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const args: Record<string, string | undefined> = {};
  const rest: string[] = [];
  for (const tok of tokens) {
    const low = tok.toLowerCase();
    if ((RANGE_CHOICES as readonly string[]).includes(low) && !args.range) args.range = low;
    else if ((STYLE_CHOICES as readonly string[]).includes(low) && !args.style) args.style = low;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && !args.from) args.from = tok;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(tok) && !args.to) args.to = tok;
    else rest.push(tok);
  }
  args.ticker = rest.join(" ");
  return args;
}

async function serveChart(
  responseUrl: string,
  origin: string,
  args: Record<string, string | undefined>,
  env: Env,
): Promise<void> {
  try {
    const result = await runChart(args, env);
    const blocks: unknown[] = [{ type: "section", text: { type: "mrkdwn", text: toMrkdwn(result.text) } }];
    if (result.image) {
      const key = await storeChart(env.CHARTS, result.image.png);
      blocks.push({ type: "image", image_url: `${origin}/${key}`, alt_text: stripMarkdown(result.text) });
    }
    await post(responseUrl, { response_type: "in_channel", text: stripMarkdown(result.text), blocks });
  } catch (err) {
    await post(responseUrl, { response_type: "ephemeral", text: `⚠️ ${(err as Error).message}` });
  }
}

async function verifySlack(body: string, signature: string, timestamp: string, secret: string): Promise<boolean> {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SEC) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const expected = `v0=${[...mac].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function toMrkdwn(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "*$1*");
}

function stripMarkdown(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1");
}

function post(url: string, payload: unknown): Promise<Response> {
  return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
}

function ephemeral(text: string): Response {
  return new Response(JSON.stringify({ response_type: "ephemeral", text }), {
    headers: { "content-type": "application/json" },
  });
}
