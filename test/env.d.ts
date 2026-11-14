import type { Env as WorkerEnv } from "../cloudflare/env.d.ts";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
