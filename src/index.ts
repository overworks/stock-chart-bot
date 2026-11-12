export { AliasWriter } from "./core/alias-writer";
import type { Providers } from "./core/market";
import { serveChart } from "./core/store";
import { handleDiscord } from "./platforms/discord";
import { handleSlack } from "./platforms/slack";
import { createProviders } from "./providers";

// KIS 토큰 메모리 캐시가 요청 사이에 유지되도록 env가 같으면 조립 결과를 재사용한다.
let assembled: { env: Env; providers: Providers } | undefined;

function providersFor(env: Env): Providers {
  if (assembled?.env !== env) {
    assembled = { env, providers: createProviders({ kisAppKey: env.KIS_APP_KEY, kisAppSecret: env.KIS_APP_SECRET, kv: env.KV }) };
  }
  return assembled.providers;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/discord") return handleDiscord(req, env, ctx, providersFor(env));
    if (pathname === "/slack") return handleSlack(req, env, ctx, providersFor(env));
    if (pathname.startsWith("/charts/") && req.method === "GET") return serveChart(env.CHARTS, pathname);
    return new Response(pathname === "/" ? "stock-chart-bot" : "not found", { status: pathname === "/" ? 200 : 404 });
  },
};
