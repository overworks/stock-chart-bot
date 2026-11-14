import type { Providers } from "../core/market.ts";
import type { MarketFetch } from "../core/http.ts";
import type { TokenCache } from "../core/storage.ts";
import { createKis } from "./kis.ts";
import { createUpbit } from "./upbit.ts";
import { createYahoo } from "./yahoo.ts";

export interface ProvidersConfig {
  kisAppKey?: string;
  kisAppSecret?: string;
  /** KIS 접근 토큰 캐시용 */
  tokenCache?: TokenCache;
  marketFetch?: MarketFetch;
}

/** 앞에서부터 시도한다. KIS는 앱키와 시크릿이 모두 있을 때만 넣는다. */
export function createProviders({ kisAppKey, kisAppSecret, tokenCache, marketFetch }: ProvidersConfig = {}): Providers {
  const kis = kisAppKey && kisAppSecret ? [createKis({ appKey: kisAppKey, appSecret: kisAppSecret, tokenCache })] : [];
  return [createUpbit(marketFetch), ...kis, createYahoo(marketFetch)];
}
