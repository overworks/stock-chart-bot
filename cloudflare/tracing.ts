import { tracing } from "cloudflare:workers";
import type { Tracer } from "../src/core/runtime";

export const workerTracer: Tracer = {
  enterSpan: (name, work) => tracing.enterSpan(name, work),
};
