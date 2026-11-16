import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXCLUDED = "realtime,imgproxy,mailpit,postgres-meta,studio,logflare,vector,supavisor";
const workspace = mkdtempSync(join(tmpdir(), "stock-chart-supabase-test-"));
const logPath = join(workspace, "supabase.log");
const log = openSync(logPath, "w", 0o600);
let started = false;
let cleaned = false;
let edge: ChildProcess | undefined;

function cli(args: string[]): string {
  return execFileSync("supabase", [...args, "--workdir", workspace], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", log] });
}

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  if (edge?.pid) {
    try { process.kill(-edge.pid, "SIGTERM"); } catch {}
  }
  let stopped = !started;
  if (started) {
    const result = spawnSync("supabase", ["stop", "--no-backup", "--workdir", workspace], { stdio: ["ignore", log, log] });
    stopped = result.status === 0;
    if (!stopped) { console.error(`검증용 Supabase 정리에 실패했습니다: ${workspace}`); process.exitCode = 1; }
  }
  closeSync(log);
  if (stopped && !process.exitCode) rmSync(workspace, { recursive: true, force: true });
}

process.on("SIGINT", () => { process.exitCode = 130; cleanup(); process.exit(); });
process.on("SIGTERM", () => { process.exitCode = 143; cleanup(); process.exit(); });

try {
  const version = execFileSync("supabase", ["--version"], { encoding: "utf8" }).trim();
  if (version !== "3.1.0") throw new Error("로컬 통합 검증에는 Supabase CLI 3.1.0이 필요합니다.");
  execFileSync("npm", ["run", "test:render:supabase"], { cwd: ROOT, stdio: "inherit" });
  const servers = [createServer(), createServer(), createServer()];
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  })));
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  mkdirSync(join(workspace, "supabase"));
  cpSync(join(ROOT, "supabase/migrations"), join(workspace, "supabase/migrations"), { recursive: true });
  cpSync(join(ROOT, "src"), join(workspace, "src"), { recursive: true });
  cpSync(join(ROOT, "supabase/functions"), join(workspace, "supabase/functions"), {
    recursive: true, filter: (source) => !basename(source).startsWith(".env"),
  });
  cpSync(join(ROOT, "test/supabase/edge/bootstrap.ts"), join(workspace, "supabase/functions/stock-chart-bot/bootstrap.ts"));
  cpSync(join(ROOT, "test/supabase/edge/fixtures.sql"), join(workspace, "supabase/migrations/20261114000001_edge_fixtures.sql"));
  cpSync(join(ROOT, "test/supabase/operations/fixtures.sql"), join(workspace, "supabase/migrations/20261116000000_operations_fixtures.sql"));
  const signing = JSON.parse(readFileSync(join(ROOT, "test/keypair.json"), "utf8")) as { publicHex: string };
  writeFileSync(join(workspace, "supabase/functions/.env"), [
    "DISCORD_APPLICATION_ID=fixture-app", `DISCORD_PUBLIC_KEY=${signing.publicHex}`,
    "SLACK_SIGNING_SECRET=local-edge-slack-secret", "SLACK_ALIAS_ADMINS=U_ADMIN", "",
  ].join("\n"), { mode: 0o600 });
  const overrides = new Map([
    ["project_id", `"stock-chart-bot-test-${randomUUID().slice(0, 8)}"`],
    ["api.port", String(ports[0])], ["db.port", String(ports[1])], ["db.shadow_port", String(ports[2])],
    ["functions.stock-chart-bot.entrypoint", '"./functions/stock-chart-bot/bootstrap.ts"'],
  ]);
  let section = "";
  const config = readFileSync(join(ROOT, "supabase/config.toml"), "utf8").split("\n").map((line) => {
    const heading = line.match(/^\[([^\]]+)\]/);
    if (heading) section = heading[1];
    const key = line.match(/^(\w+)\s*=/)?.[1];
    const path = section ? `${section}.${key}` : key;
    const value = path && overrides.get(path);
    if (path && value) { overrides.delete(path); return `${key} = ${value}`; }
    return line;
  }).join("\n");
  if (overrides.size) throw new Error("검증용 프로젝트 ID와 포트를 분리하지 못했습니다.");
  writeFileSync(join(workspace, "supabase/config.toml"), config);
  console.log("격리된 로컬 Supabase를 시작합니다.");
  started = true;
  execFileSync("supabase", ["start", "--workdir", workspace, "--exclude", EXCLUDED], { cwd: ROOT, stdio: ["ignore", log, log] });
  const status = JSON.parse(cli(["status", "--output", "json"])) as Record<string, string>;
  if (!status.API_URL || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.API_URL).hostname) || Number(new URL(status.API_URL).port) !== ports[0]) {
    throw new Error("통합 검증은 로컬 Supabase에서만 실행할 수 있습니다.");
  }
  if (!status.SERVICE_ROLE_KEY || !status.ANON_KEY) throw new Error("로컬 검증 자격증명을 읽지 못했습니다.");
  edge = spawn("supabase", ["functions", "serve", "stock-chart-bot", "--workdir", workspace, "--env-file", join(workspace, "supabase/functions/.env")], {
    cwd: ROOT, stdio: ["ignore", log, log], detached: true,
  });
  let edgeError: Error | undefined;
  edge.on("error", (err) => { edgeError = err; });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (edgeError || edge.exitCode !== null) throw new Error("로컬 Edge Runtime 실행에 실패했습니다.");
    try {
      const response = await fetch(`${status.API_URL}/functions/v1/stock-chart-bot/`, { signal: AbortSignal.timeout(60_000) });
      const body = await response.text();
      if (response.ok && body === "stock-chart-bot") { ready = true; break; }
      if (response.status >= 500) {
        writeFileSync(join(workspace, "edge-response.log"), body, { mode: 0o600 });
        throw new Error("Edge Runtime 함수 초기화에 실패했습니다.");
      }
    } catch (err) {
      if (err instanceof Error && err.message === "Edge Runtime 함수 초기화에 실패했습니다.") throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Edge Runtime 함수 준비 시간이 초과됐습니다.");
  const result = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", "test/supabase/vitest.config.ts"], {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      SUPABASE_TEST_URL: status.API_URL,
      SUPABASE_TEST_SERVICE_KEY: status.SERVICE_ROLE_KEY,
      SUPABASE_TEST_ANON_KEY: status.ANON_KEY,
      WRANGLER_LOG_PATH: join(workspace, "wrangler.log"),
    },
  });
  process.exitCode = result.status ?? 1;
} catch (err) {
  console.error(err instanceof Error ? err.message.split("\n")[0] : "로컬 Supabase 검증에 실패했습니다.");
  console.error(`상세 로그: ${logPath}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
