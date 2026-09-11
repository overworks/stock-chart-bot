declare module "*.wasm" {
  const mod: WebAssembly.Module;
  export default mod;
}

interface Env {
  DISCORD_PUBLIC_KEY: string;
  DISCORD_APPLICATION_ID: string;
  DISCORD_BOT_TOKEN: string;
  SYMBOLS: KVNamespace;
  CHARTS: R2Bucket;
}
