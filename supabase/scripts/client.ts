import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { createChartClient } from "../functions/stock-chart-bot/adapters.ts";
import { serverKey } from "../functions/stock-chart-bot/config.ts";
import { logEvent, exceptionAttributes } from "../../src/core/log.ts";
import { OperationError } from "./operations.ts";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const CLI_VERSION = "3.1.0";

export function argumentsFor(kind: "seed" | "cleanup" | "deploy") {
  try {
    const { values } = parseArgs({ options: {
      "project-ref": { type: "string" }, help: { type: "boolean", short: "h" },
      ...(kind === "seed" ? { file: { type: "string" as const } } : {}),
      ...(kind === "cleanup" ? { "dry-run": { type: "boolean" as const } } : {}),
    } });
    return {
      projectRef: typeof values["project-ref"] === "string" ? values["project-ref"] : undefined,
      file: typeof values.file === "string" ? values.file : undefined,
      dryRun: values["dry-run"] === true, help: values.help === true,
    };
  } catch { throw new OperationError("명령 인자를 확인해 주세요. --help로 사용법을 볼 수 있습니다."); }
}

export function projectRef(value?: string, required = false): string | undefined {
  const ref = value ?? process.env.SUPABASE_PROJECT_REF;
  if (ref && !/^[a-z0-9]{20}$/.test(ref)) throw new OperationError("Supabase 프로젝트 ref 형식이 올바르지 않습니다.");
  if (!ref && required) throw new OperationError("--project-ref 또는 SUPABASE_PROJECT_REF가 필요합니다.");
  return ref || undefined;
}

function cliOutput(args: string[]): string {
  try { return execFileSync("supabase", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new OperationError("Supabase CLI 인증과 실행 권한을 확인해 주세요."); }
}

export function requireCli(): void {
  if (cliOutput(["--version"]).trim() !== CLI_VERSION) throw new OperationError(`Supabase CLI ${CLI_VERSION}이 필요합니다.`);
}

export function runCli(args: string[]): void {
  try { execFileSync("supabase", args, { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] }); }
  catch { throw new OperationError("Supabase CLI 작업에 실패했습니다."); }
}

export function operationsClient(value?: string) {
  const ref = projectRef(value);
  const input = process.env.SUPABASE_URL ?? (ref ? `https://${ref}.supabase.co` : undefined);
  if (!input) throw new OperationError("SUPABASE_URL 또는 프로젝트 ref가 필요합니다.");
  let url: URL;
  try { url = new URL(input); } catch { throw new OperationError("Supabase API 주소가 올바르지 않습니다."); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/"
    || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new OperationError("Supabase API 주소가 올바르지 않습니다.");
  if (ref && url.origin !== `https://${ref}.supabase.co`) throw new OperationError("프로젝트 ref와 SUPABASE_URL이 일치하지 않습니다.");
  let key = process.env.SUPABASE_SECRET_KEY;
  if (!key && (process.env.SUPABASE_SECRET_KEYS || process.env.SUPABASE_SERVICE_ROLE_KEY)) {
    try { key = serverKey((name) => process.env[name]); }
    catch { throw new OperationError("Supabase 서버 키 환경변수를 확인해 주세요."); }
  }
  if (!key && ref) {
    requireCli();
    try {
      const keys: unknown = JSON.parse(cliOutput(["projects", "api-keys", `--remote=${ref}`, "--output", "json", "--reveal"]));
      if (Array.isArray(keys)) key = keys.find((item) => item.type === "secret")?.api_key ?? keys.find((item) => item.name === "service_role")?.api_key;
    } catch { throw new OperationError("서버 키를 읽지 못했습니다. SUPABASE_SECRET_KEY를 설정하거나 Supabase CLI 인증을 확인해 주세요."); }
  }
  if (!key || typeof key !== "string") throw new OperationError("SUPABASE_SECRET_KEY 또는 SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
  return createChartClient(url.origin, key);
}

export function seedFile(file = fileURLToPath(new URL("../../scripts/symbols.json", import.meta.url))): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new OperationError("종목 JSON 파일을 읽지 못했습니다."); }
}

export async function main(operation: string, work: () => Promise<void>): Promise<void> {
  try { await work(); }
  catch (error) {
    const safe = error instanceof OperationError ? error : new OperationError("Supabase 운영 작업에 실패했습니다.");
    logEvent("error", "chart.operation.failed", { "chart.operation": operation, ...exceptionAttributes(safe) });
    process.exitCode = 1;
  }
}
