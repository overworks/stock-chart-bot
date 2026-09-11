import { handleDiscord } from "./platforms/discord";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    switch (pathname) {
      case "/discord":
        return handleDiscord(req, env, ctx);
      // Future: case "/slack": return handleSlack(req, env, ctx);
      default:
        return new Response("stock-chart-bot", { status: 200 });
    }
  },
};
