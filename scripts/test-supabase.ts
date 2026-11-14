import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EXCLUDED = "realtime,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
const workspace = mkdtempSync(join(tmpdir(), "stock-chart-supabase-test-"));
const logPath = join(workspace, "supabase.log");
const log = openSync(logPath, "w", 0o600);
let started = false;
let cleaned = false;

function cli(args: string[]): string {
  return execFileSync("supabase", [...args, "--workdir", workspace], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", log] });
}

function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
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
  const servers = [createServer(), createServer(), createServer()];
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  })));
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))));
  mkdirSync(join(workspace, "supabase"));
  cpSync(join(ROOT, "supabase/migrations"), join(workspace, "supabase/migrations"), { recursive: true });
  const overrides = new Map([
    ["project_id", `"stock-chart-bot-test-${randomUUID().slice(0, 8)}"`],
    ["api.port", String(ports[0])], ["db.port", String(ports[1])], ["db.shadow_port", String(ports[2])],
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
