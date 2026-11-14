import type { MarketFetch } from "../src/core/http.ts";

export const cloudflareMarketFetch: MarketFetch = (input, init, cacheTtlSeconds) => fetch(
  input,
  cacheTtlSeconds === undefined ? init : {
    ...init,
    cf: { cacheTtl: cacheTtlSeconds, cacheEverything: true },
  },
);
