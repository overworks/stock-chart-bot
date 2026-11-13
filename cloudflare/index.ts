export { AliasWriter } from "./alias-writer";
import { createApp } from "../src/app";
import { createProviders } from "../src/providers";
import type { Env } from "./env";
import { renderPng } from "./assets";
import { createImagePublisher, serveChart } from "./images";
import { createKisTokenCache, createSymbolStore } from "./storage";
import { workerTracer } from "./tracing";

let assembled: { env: Env; app: ReturnType<typeof createApp> } | undefined;

function appFor(env: Env) {
  if (assembled?.env !== env) {
    const app = createApp({
      discordPublicKey: env.DISCORD_PUBLIC_KEY,
      discordApplicationId: env.DISCORD_APPLICATION_ID,
      slackSigningSecret: env.SLACK_SIGNING_SECRET,
      slackAliasAdmins: env.SLACK_ALIAS_ADMINS,
    }, {
      providers: createProviders({ kisAppKey: env.KIS_APP_KEY, kisAppSecret: env.KIS_APP_SECRET, tokenCache: createKisTokenCache(env.KV) }),
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
