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
  SYMBOLS: KVNamespace;
  CHARTS: R2Bucket;
}
