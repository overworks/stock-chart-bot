export { AliasWriter } from "./alias-writer.ts";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/providers/index.ts";
import type { Env } from "./env.d.ts";
import { renderPng } from "./assets.ts";
import { createImagePublisher, serveChart } from "./images.ts";
import { createKisTokenCache, createSymbolStore } from "./storage.ts";
import { workerTracer } from "./tracing.ts";
import { cloudflareMarketFetch } from "./http.ts";

let assembled: { env: Env; app: ReturnType<typeof createApp> } | undefined;

function appFor(env: Env) {
  if (assembled?.env !== env) {
    const app = createApp({
      discordPublicKey: env.DISCORD_PUBLIC_KEY,
      discordApplicationId: env.DISCORD_APPLICATION_ID,
      slackSigningSecret: env.SLACK_SIGNING_SECRET,
      slackAliasAdmins: env.SLACK_ALIAS_ADMINS,
    }, {
      providers: createProviders({
        kisAppKey: env.KIS_APP_KEY,
        kisAppSecret: env.KIS_APP_SECRET,
        tokenCache: createKisTokenCache(env.KV),
        marketFetch: cloudflareMarketFetch,
      }),
      symbols: createSymbolStore(env),
      render: renderPng,
      tracer: workerTracer,
      images: createImagePublisher(env.CHARTS),
      serveImage: (pathname) => serveChart(env.CHARTS, pathname),
    });
    assembled = { env, app };
  }
  return assembled.app;
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return appFor(env).fetch(req, { waitUntil: (task) => ctx.waitUntil(task) });
  },
};
