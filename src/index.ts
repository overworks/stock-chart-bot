export { AliasWriter } from "../cloudflare/alias-writer";
import { createKisTokenCache, createSymbolStore } from "../cloudflare/storage";
import type { Providers } from "./core/market";
import type { SymbolStore } from "./core/storage";
import { serveChart } from "./core/store";
import { handleDiscord } from "./platforms/discord";
import { handleSlack } from "./platforms/slack";
import { createProviders } from "./providers";

// 같은 env에서는 제공자와 저장소 인스턴스를 재사용해 메모리 캐시를 유지한다.
let assembled: { env: Env; providers: Providers; symbols: SymbolStore } | undefined;

function servicesFor(env: Env) {
  if (assembled?.env !== env) {
    assembled = {
      env,
      providers: createProviders({ kisAppKey: env.KIS_APP_KEY, kisAppSecret: env.KIS_APP_SECRET, tokenCache: createKisTokenCache(env.KV) }),
      symbols: createSymbolStore(env),
    };
  }
  return assembled;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/discord" || pathname === "/slack") {
      const { providers, symbols } = servicesFor(env);
      return pathname === "/discord" ? handleDiscord(req, env, ctx, providers, symbols) : handleSlack(req, env, ctx, providers, symbols);
    }
    if (pathname.startsWith("/charts/") && req.method === "GET") return serveChart(env.CHARTS, pathname);
    return new Response(pathname === "/" ? "stock-chart-bot" : "not found", { status: pathname === "/" ? 200 : 404 });
  },
};
