import type { Providers } from "../core/market";
import { createKis } from "./kis";
import { upbit } from "./upbit";
import { yahoo } from "./yahoo";

export interface ProvidersConfig {
  kisAppKey?: string;
  kisAppSecret?: string;
  /** KIS 접근 토큰 캐시용 */
  kv?: KVNamespace;
}

/** 앞에서부터 시도한다. KIS는 앱키와 시크릿이 모두 있을 때만 넣는다. */
export function createProviders({ kisAppKey, kisAppSecret, kv }: ProvidersConfig = {}): Providers {
  const kis = kisAppKey && kisAppSecret ? [createKis({ appKey: kisAppKey, appSecret: kisAppSecret, kv })] : [];
  return [upbit, ...kis, yahoo];
}
