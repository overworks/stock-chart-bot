import type { Env as WorkerEnv } from "../cloudflare/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
