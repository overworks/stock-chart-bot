import type { BotConfig } from "./config.ts";
import type { BackgroundTasks, BotServices } from "./core/runtime.ts";
import { handleDiscord } from "./platforms/discord.ts";
import { handleSlack } from "./platforms/slack.ts";

export function createApp(config: BotConfig, services: BotServices) {
  return {
    async fetch(req: Request, tasks: BackgroundTasks): Promise<Response> {
      const { pathname } = new URL(req.url);
      if (pathname === "/discord") return handleDiscord(req, config, tasks, services);
      if (pathname === "/slack") return handleSlack(req, config, tasks, services);
      if (pathname.startsWith("/charts/") && req.method === "GET" && services.serveImage) return services.serveImage(pathname);
      return new Response(pathname === "/" ? "stock-chart-bot" : "not found", { status: pathname === "/" ? 200 : 404 });
    },
  };
}
