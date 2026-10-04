import { ALIASES_KEY, type SymbolEntry } from "./symbols";

interface Mutation {
  key: string;
  value?: string;
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
        await txn.setAlarm(Date.now() + 60_000);
      });
      try {
        await this.publish();
      } catch {
        return new Response("별칭 변경은 저장됐지만 검색 반영이 지연되고 있습니다. 자동으로 재시도합니다.", { status: 503 });
      }
      return Response.json(entry);
    });
  }

  async alarm(): Promise<void> {
    await this.enqueue(async () => {
      await this.state.storage.setAlarm(Date.now() + 60_000);
      await this.publish();
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
    await storage.deleteAlarm();
  }
}
