import { verifyKey } from "discord-interactions";
import { runAlias, searchAliases } from "../core/aliases";
import { runChart } from "../core/run";
import { searchSymbols } from "../core/symbols";

const API = "https://discord.com/api/v10";
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export async function handleDiscord(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (req.method !== "POST") return new Response("", { status: 405 });

  const body = await req.text();
  const signature = req.headers.get("X-Signature-Ed25519");
  const timestamp = req.headers.get("X-Signature-Timestamp");

  if (
    !signature ||
    !timestamp ||
    !(await verifyKey(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))
  ) {
    return new Response("invalid request signature", { status: 401 });
  }

  const interaction = JSON.parse(body) as any;

  // PING handshake
  if (interaction.type === 1) return json({ type: 1 });

  const { name, action, args } = parseCommand(interaction.data);

  // Autocomplete
  if (interaction.type === 4) {
    const focused = focusedOption(interaction.data);
    const query = String(focused?.value ?? "");
    const choices =
      name === "alias" && focused?.name === "alias"
        ? await searchAliases(query, env.SYMBOLS)
        : await searchSymbols(query, env.SYMBOLS);
    return json({ type: 8, data: { choices } });
  }

  // Slash command
  if (interaction.type === 2 && name === "chart") {
    ctx.waitUntil(serveChart(interaction, args, env));
    return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  if (interaction.type === 2 && name === "alias") {
    if (action !== "list" && !canManage(interaction)) {
      return json({ type: 4, data: { content: "⚠️ 서버 관리 권한이 있는 사용자만 별칭을 바꿀 수 있습니다.", flags: 64 } });
    }
    ctx.waitUntil(serveAlias(interaction, { action, ...args }, env));
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

async function serveAlias(interaction: any, args: Record<string, string | undefined>, env: Env): Promise<void> {
  let content: string;
  try {
    content = await runAlias(args, env);
  } catch (err) {
    content = `⚠️ ${(err as Error).message}`;
  }
  await patchOriginal(interaction, env, { content });
}

async function serveChart(
  interaction: any,
  args: Record<string, string | undefined>,
  env: Env,
): Promise<void> {
  const endpoint = `${API}/webhooks/${env.DISCORD_APPLICATION_ID}/${interaction.token}/messages/@original`;
  try {
    const result = await runChart(args, env);
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
    await fetch(endpoint, { method: "PATCH", body: form });
  } catch (err) {
    await patchOriginal(interaction, env, { content: `⚠️ ${(err as Error).message}` });
  }
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
