declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}

declare module "*.ttf" {
  const data: ArrayBuffer;
  export default data;
}

interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_ALIAS_ADMINS?: string;
  KIS_APP_KEY?: string;
  KIS_APP_SECRET?: string;
  KV: KVNamespace;
  ALIAS_WRITER: DurableObjectNamespace;
  CHARTS: R2Bucket;
}
