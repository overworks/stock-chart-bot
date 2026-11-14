export type MarketFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
  cacheTtlSeconds?: number,
) => Promise<Response>;
