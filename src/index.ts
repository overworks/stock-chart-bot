export { AliasWriter } from "./core/alias-writer";
import { configureKis } from "./core/market";
import { serveChart } from "./core/store";
import { handleDiscord } from "./platforms/discord";
import { handleSlack } from "./platforms/slack";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);
    configureKis(env.KIS_APP_KEY, env.KIS_APP_SECRET, env.KV);

    if (pathname === "/discord") return handleDiscord(req, env, ctx);
    if (pathname === "/slack") return handleSlack(req, env, ctx);
    if (pathname.startsWith("/charts/") && req.method === "GET") return serveChart(env.CHARTS, pathname);
    return new Response(pathname === "/" ? "stock-chart-bot" : "not found", { status: pathname === "/" ? 200 : 404 });
  },
};
