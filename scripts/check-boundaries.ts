import { parse } from "@babel/parser";
import { builtinModules } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const NODE_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const HOST_GLOBALS = new Set([
  "process", "Buffer", "require", "__dirname", "__filename", "Deno", "Bun",
  "Env", "ExecutionContext", "KVNamespace", "R2Bucket", "DurableObjectNamespace", "DurableObjectState",
]);

function files(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() && path.endsWith(".ts") ? [path] : [];
  }).sort();
}

function inside(path: string, directory: string): boolean {
  return path.startsWith(`${directory}${sep}`);
}

function literal(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if (node.type === "StringLiteral" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && Array.isArray(node.expressions) && node.expressions.length === 0) {
    const quasis = node.quasis as { value: { cooked: string } }[];
    return quasis[0]?.value.cooked;
  }
}

export function checkBoundaries(root = PROJECT_ROOT): string[] {
  const errors: string[] = [];
  const src = resolve(root, "src");
  for (const file of ["src", "cloudflare", "supabase", "scripts", "test"].flatMap((dir) => files(resolve(root, dir)))) {
    const shared = inside(file, src);
    const core = inside(file, resolve(src, "core"));
    function report(node: Record<string, unknown>, message: string) {
      const loc = (node.loc as { start: { line: number; column: number } } | undefined)?.start;
      errors.push(`${relative(root, file)}:${loc?.line ?? 1}:${(loc?.column ?? 0) + 1} ${message}`);
    }
    function checkImport(specifier: string, node: Record<string, unknown>) {
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(file), specifier);
        if (!extname(specifier)) report(node, `상대 import에 확장자가 필요합니다: ${specifier}`);
        else if (!existsSync(target) || !statSync(target).isFile()) report(node, `import 파일을 찾을 수 없습니다: ${specifier}`);
        if (shared && !inside(target, src)) report(node, `공통 코드에서 실행 환경 구현을 참조할 수 없습니다: ${specifier}`);
        if (core && ["providers", "platforms"].some((dir) => inside(target, resolve(src, dir)))) {
          report(node, `core에서 제공자·메신저 구현을 참조할 수 없습니다: ${specifier}`);
        }
      } else if (shared && (isAbsolute(specifier) || NODE_MODULES.has(specifier) || /^(file:|node:|cloudflare:|bun:|@cloudflare\/|@supabase\/|npm:|jsr:)/.test(specifier))) {
        report(node, `공통 코드에서 런타임 전용 모듈을 참조할 수 없습니다: ${specifier}`);
      } else if (core && specifier.split("/")[0] === "discord-interactions") {
        report(node, "core에서 메신저 SDK를 참조할 수 없습니다.");
      }
    }
    function visit(value: unknown): void {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const node = value as Record<string, unknown>;
      if (typeof node.type !== "string") return;
      let source: unknown;
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "ImportExpression"].includes(node.type)) source = node.source;
      if (node.type === "TSImportType") source = node.argument;
      if (node.type === "TSExternalModuleReference") source = node.expression;
      if (node.type === "CallExpression" && (node.callee as { name?: string })?.name === "require") source = (node.arguments as unknown[])[0];
      const specifier = literal(source);
      if (specifier !== undefined) checkImport(specifier, node);
      else if (shared && node.type === "ImportExpression") report(node, "공통 코드의 동적 import에는 고정 경로가 필요합니다.");
      if (shared && node.type === "Identifier" && HOST_GLOBALS.has(node.name as string)) report(node, `공통 코드에 런타임 전용 이름을 사용할 수 없습니다: ${node.name}`);
      if (shared && node.type === "MemberExpression" && (node.object as { name?: string })?.name === "globalThis") {
        const property = literal(node.property);
        if (property && HOST_GLOBALS.has(property)) report(node, `공통 코드에 런타임 전역을 사용할 수 없습니다: ${property}`);
      }
      for (const [key, child] of Object.entries(node)) {
        if (!["loc", "comments", "leadingComments", "innerComments", "trailingComments"].includes(key)) visit(child);
      }
    }
    try {
      visit(parse(readFileSync(file, "utf8"), {
        sourceType: "module",
        plugins: [["typescript", { dts: file.endsWith(".d.ts") }], "importAttributes"],
        createImportExpressions: true,
      }).program);
    } catch (err) {
      errors.push(`${relative(root, file)}: 구문 검사 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkBoundaries();
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("import 경계와 상대 경로 검사를 통과했습니다.");
  }
}
