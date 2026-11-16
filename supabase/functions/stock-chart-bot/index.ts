import type { BackgroundTasks } from "../../../src/core/runtime.ts";
import { renderPng } from "./assets.ts";
import { createSupabaseHandler } from "./handler.ts";

declare const EdgeRuntime: BackgroundTasks;

Deno.serve(createSupabaseHandler((name) => Deno.env.get(name), renderPng, {
  waitUntil: (task) => EdgeRuntime.waitUntil(task),
}));
