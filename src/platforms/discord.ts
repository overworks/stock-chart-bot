import { verifyKey } from "discord-interactions";
import type { MutationIdentity } from "../core/alias-writer";
import { runAlias, searchAliases } from "../core/aliases";
import { errorMessage, logEvent } from "../core/log";
import type { Providers } from "../core/market";
import { runChart } from "../core/run";
import { searchSymbols } from "../core/symbols";
import { helpText } from "./help";
import { DELIVERY_FAILED_TEXT, reportCommand } from "./report";

const API = "https://discord.com/api/v10";
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;
const TOLERANCE_SEC = 5 * 60;
const MAX_CONTENT_LENGTH = 2000;

export async function handleDiscord(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  providers: Providers,
): Promise<Response> {
  if (req.method !== "POST") return new Response("", { status: 405 });

  const body = await req.text();
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");

  if (
    !signature ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    !Number.isSafeInteger(Number(timestamp)) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SEC ||
    !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(body) as any;

  // PING handshake
  if (interaction.type === 1) return json({ type: 1 });

  const { name, action, args } = parseCommand(interaction.data);
  const isAliasCommand = name === "stock-alias";

  // Autocomplete
  if (interaction.type === 4) {
    const focused = focusedOption(interaction.data);
    const query = String(focused?.value ?? "");
    const choices =
      isAliasCommand && focused?.name === "alias"
        ? await searchAliases(query, env.KV)
        : await searchSymbols(query, env.KV, providers);
    return json({ type: 8, data: { choices } });
  }

  // Slash command
  if (interaction.type === 2 && name === "stock-help") {
    return json({ type: 4, data: { content: helpText("discord"), flags: 64 } });
  }

  if (interaction.type === 2 && name === "stock-chart") {
    ctx.waitUntil(serveChart(interaction, args, env, providers));
    return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  if (interaction.type === 2 && isAliasCommand) {
    if (action !== "list" && !canManage(interaction)) {
      logEvent("warn", "chart.alias.denied", { "chart.platform": "discord", "chart.alias.action": action });
      return json({ type: 4, data: { content: "⚠️ 서버 관리 권한이 있는 사용자만 별칭을 바꿀 수 있습니다.", flags: 64 } });
    }
    if (action !== "list" && (typeof interaction.id !== "string" || !interaction.id)) {
      return new Response("invalid interaction id", { status: 400 });
    }
    const request = action === "list" ? undefined : {
      key: `discord:${interaction.id}`,
      expiresAt: (Number(timestamp) + TOLERANCE_SEC + 1) * 1000,
    };
    ctx.waitUntil(serveAlias(interaction, { action, ...args }, env, providers, request));
    return json({ type: 5 });
  }

  return json({ type: 4, data: { content: "알 수 없는 명령입니다." } });
}

/** 서브커맨드가 있으면 한 단계 풀어서 {action, args}로 만든다. */
function parseCommand(data: any): { name: string; action?: string; args: Record<string, string | undefined> } {
  const options: any[] = data?.options ?? [];
  const sub = options.find((o) => o.type === 1);
  const leaf: any[] = sub ? sub.options ?? [] : options;
  return {
    name: String(data?.name ?? ""),
    action: sub?.name,
    args: Object.fromEntries(leaf.map((o) => [o.name, o.value])),
  };
}

function focusedOption(data: any): any {
  const options: any[] = data?.options ?? [];
  const sub = options.find((o) => o.type === 1);
  return (sub ? sub.options ?? [] : options).find((o: any) => o.focused);
}

function canManage(interaction: any): boolean {
  const raw = interaction.member?.permissions;
  if (typeof raw !== "string") return false;
  try {
    return (BigInt(raw) & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
  } catch {
    return false;
  }
}

async function serveAlias(interaction: any, args: Record<string, string | undefined>, env: Env, providers: Providers, request?: MutationIdentity): Promise<void> {
  const started = Date.now();
  let content: string;
  let error: unknown;
  try {
    content = await runAlias(args, env, providers, request);
  } catch (err) {
    error = err;
    content = `⚠️ ${errorMessage(err)}`;
  }
  await reportCommand({ platform: "discord", command: "stock-alias", action: args.action, started, error }, () =>
    sendAliasContent(interaction, env, content),
  );
}

async function sendAliasContent(interaction: any, env: Env, content: string): Promise<Response> {
  const chunks: string[] = [];
  while (content.length > MAX_CONTENT_LENGTH) {
    let end = content.lastIndexOf("\n", MAX_CONTENT_LENGTH);
    if (end <= 0) {
      end = MAX_CONTENT_LENGTH;
      const code = content.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end--;
    }
    chunks.push(content.slice(0, end));
    content = content.slice(end);
    if (content.startsWith("\n")) content = content.slice(1);
  }
  chunks.push(content);
  let response = await patchOriginal(interaction, env, { content: chunks[0] });
  for (const chunk of chunks.slice(1)) {
    if (!response.ok) break;
    response = await fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}?wait=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: chunk }),
    });
  }
  return response;
}

async function serveChart(
  interaction: any,
  args: Record<string, string | undefined>,
  env: Env,
  providers: Providers,
): Promise<void> {
  const endpoint = `${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  const started = Date.now();
  let error: unknown;
  let send: () => Promise<Response>;
  let fallback: (() => Promise<Response>) | undefined;
  try {
    const result = await runChart(args, env, providers);
    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: result.text,
        embeds: [
          {
            image: { url: "attachment://chart.png" },
            ...(result.color ? { color: parseInt(result.color.slice(1), 16) } : {}),
            ...(result.source ? { footer: { text: `출처: ${result.source}` } } : {}),
          },
        ],
      }),
    );
    if (result.image) {
      form.append(
        "files[0]",
        new File([result.image.png], result.image.filename, { type: "image/png" }),
      );
    }
    send = () => fetch(endpoint, { method: "PATCH", body: form });
    fallback = () => patchOriginal(interaction, env, { content: DELIVERY_FAILED_TEXT });
  } catch (err) {
    error = err;
    send = () => patchOriginal(interaction, env, { content: `⚠️ ${errorMessage(err)}` });
  }
  await reportCommand({ platform: "discord", command: "stock-chart", started, error }, send, fallback);
}

function patchOriginal(interaction: any, env: Env, payload: unknown): Promise<Response> {
  return fetch(`${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}
