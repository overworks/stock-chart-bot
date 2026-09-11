import { verifyKey } from "discord-interactions";
import { runChart } from "../core/run";
import { searchSymbols } from "../core/symbols";

const API = "https://discord.com/api/v10";

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

  // Autocomplete
  if (interaction.type === 4) {
    const focused = (interaction.data.options ?? []).find((o: any) => o.focused);
    const query = String(focused?.value ?? "");
    const choices = await searchSymbols(query, env.SYMBOLS);
    return json({ type: 8, data: { choices } });
  }

  // Slash command
  if (interaction.type === 2 && interaction.data.name === "chart") {
    const args = Object.fromEntries(
      (interaction.data.options ?? []).map((o: any) => [o.name, o.value]),
    );
    ctx.waitUntil(serveChart(interaction, args, env));
    return json({ type: 5 }); // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
  }

  return json({ type: 4, data: { content: "알 수 없는 명령입니다." } });
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
        embeds: [{ image: { url: "attachment://chart.png" } }],
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
    await fetch(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `⚠️ ${(err as Error).message}` }),
    });
  }
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
  });
}
