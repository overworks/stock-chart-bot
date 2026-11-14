import type { Providers } from "./market.ts";
import type { SymbolStore } from "./storage.ts";

export type ChartRenderer = (svg: string, width?: number) => Promise<Uint8Array>;

export interface TraceSpan {
  setAttributes(attributes: Record<string, string | number | boolean | undefined>): void;
}

export interface Tracer {
  enterSpan<T>(name: string, work: (span: TraceSpan) => Promise<T>): Promise<T>;
}

export const noopTracer: Tracer = {
  enterSpan: (_name, work) => work({ setAttributes() {} }),
};

export interface ChartRuntime {
  render: ChartRenderer;
  tracer?: Tracer;
}

export interface BackgroundTasks {
  waitUntil(task: Promise<unknown>): void;
}

export interface ImagePublisher {
  publish(png: Uint8Array, requestUrl: string): Promise<string>;
}

export interface BotServices extends ChartRuntime {
  providers: Providers;
  symbols: SymbolStore;
  images: ImagePublisher;
  serveImage?: (pathname: string) => Promise<Response>;
}
