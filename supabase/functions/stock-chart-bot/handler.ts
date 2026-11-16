import { createApp } from "../../../src/app.ts";
import { createProviders } from "../../../src/providers/index.ts";
import type { BackgroundTasks, ChartRenderer } from "../../../src/core/runtime.ts";
import { createChartClient, createImagePublisher, createKisTokenCache, createSymbolStore } from "./adapters.ts";
import { botConfig, serverKey, type EnvReader } from "./config.ts";

export function normalizeRequest(request: Request): Request {
  const url = new URL(request.url);
  for (const prefix of ["/functions/v1/stock-chart-bot", "/stock-chart-bot"]) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) {
      url.pathname = url.pathname.slice(prefix.length) || "/";
      return new Request(url, request);
    }
  }
  return request;
}

export function createSupabaseHandler(env: EnvReader, render: ChartRenderer, tasks: BackgroundTasks) {
  const url = env("SUPABASE_URL");
  if (!url) throw new Error("Supabase API 주소가 필요합니다.");
  const client = createChartClient(url, serverKey(env));
  const app = createApp(botConfig(env), {
    providers: createProviders({
      kisAppKey: env("KIS_APP_KEY"), kisAppSecret: env("KIS_APP_SECRET"), tokenCache: createKisTokenCache(client),
    }),
    symbols: createSymbolStore(client),
    images: createImagePublisher(client),
    render,
  });
  return (request: Request): Promise<Response> => app.fetch(normalizeRequest(request), tasks);
}
