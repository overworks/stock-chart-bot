import { exceptionAttributes, logEvent } from "./log";
import { ALIASES_KEY, type SymbolEntry } from "./symbols";

const REQUEST_PREFIX = "request:";

export interface MutationIdentity {
  key: string;
  expiresAt: number;
}

interface Mutation {
  key: string;
  value?: string;
  request?: MutationIdentity;
}

export async function mutateAlias(namespace: DurableObjectNamespace, mutation: Mutation): Promise<SymbolEntry> {
  const stub = namespace.get(namespace.idFromName(ALIASES_KEY));
  const response = await stub.fetch("https://aliases/mutate", {
    method: "POST",
    body: JSON.stringify(mutation),
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json<SymbolEntry>();
}

export class AliasWriter {
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private state: DurableObjectState, private env: { KV: KVNamespace }) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }

  async fetch(request: Request): Promise<Response> {
    const mutation = await request.json<Mutation>();
    return this.enqueue(async () => {
      const storage = this.state.storage;
      const requestKey = mutation.request && `${REQUEST_PREFIX}${mutation.request.key}`;
      if (mutation.request && mutation.request.expiresAt <= Date.now()) {
        return new Response("별칭 변경 요청이 만료됐습니다. 다시 실행해 주세요.", { status: 408 });
      }
      const recordedExpiry = requestKey ? await storage.get<number>(requestKey) : undefined;
      if (requestKey && recordedExpiry !== undefined) {
        if (mutation.request!.expiresAt > recordedExpiry) await storage.put(requestKey, mutation.request!.expiresAt);
        return new Response("이미 처리한 별칭 변경 요청입니다.", { status: 409 });
      }
      const user = (await storage.get<SymbolEntry[]>(ALIASES_KEY))
        ?? (await this.env.KV.get<SymbolEntry[]>(ALIASES_KEY, "json")) ?? [];
      const hit = user.find((entry) => entry.key === mutation.key);
      if (mutation.value === undefined && !hit) {
        return new Response(`'${mutation.key}' 별칭이 없습니다.`, { status: 404 });
      }
      const entry = mutation.value === undefined ? hit! : { key: mutation.key, value: mutation.value };
      const next = user.filter((item) => item.key !== mutation.key);
      if (mutation.value !== undefined) next.push(entry);
      await storage.transaction(async (txn) => {
        await txn.put(ALIASES_KEY, next);
        if (requestKey) await txn.put(requestKey, mutation.request!.expiresAt);
        await txn.put("publishPending", true);
        await txn.setAlarm(Date.now() + 60_000);
      });
      try {
        await this.publish();
      } catch (err) {
        logEvent("warn", "chart.alias.publish_deferred", exceptionAttributes(err));
        return new Response("별칭 변경은 저장됐지만 검색 반영이 지연되고 있습니다. 자동으로 재시도합니다.", { status: 503 });
      }
      return Response.json(entry);
    });
  }

  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      try {
        if (await this.state.storage.get("publishPending") === false) await this.cleanupRequests();
        else await this.publish();
      } catch (err) {
        logEvent("error", "chart.alias.publish_failed", exceptionAttributes(err));
        throw err;
      }
    });
  }

  private async publish(): Promise<void> {
    const storage = this.state.storage;
    const nextWrite = (await storage.get<number>("nextWrite")) ?? 0;
    const delay = nextWrite - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const entries = (await storage.get<SymbolEntry[]>(ALIASES_KEY)) ?? [];
    await storage.put("nextWrite", Date.now() + 1100);
    await this.env.KV.put(ALIASES_KEY, JSON.stringify(entries));
    await storage.put("nextWrite", Date.now() + 1100);
    await storage.put("publishPending", false);
    await this.cleanupRequests();
  }

  private async cleanupRequests(): Promise<void> {
    const storage = this.state.storage;
    const requests = await storage.list<number>({ prefix: REQUEST_PREFIX });
    const expired: string[] = [];
    let expiresAt = 0;
    for (const [key, expiry] of requests) {
      if (expiry <= Date.now()) expired.push(key);
      else expiresAt = Math.max(expiresAt, expiry);
    }
    for (let i = 0; i < expired.length; i += 128) await storage.delete(expired.slice(i, i + 128));
    if (expiresAt) await storage.setAlarm(expiresAt);
    else await storage.deleteAlarm();
  }
}
