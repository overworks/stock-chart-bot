import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

export function prepareSupabaseAssets(root = ROOT): void {
  const folder = join(root, "supabase/functions/stock-chart-bot");
  const config = JSON.parse(readFileSync(join(folder, "deno.json"), "utf8")) as { imports: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
  for (const name of ["@resvg/resvg-wasm", "@supabase/supabase-js", "discord-interactions"]) {
    if (config.imports[name] !== `npm:${name}@${lock.packages[`node_modules/${name}`]?.version}`) {
      throw new Error(`npm과 Deno 의존성 버전을 맞춰야 합니다: ${name}`);
    }
  }
  mkdirSync(join(folder, "_assets"), { recursive: true });
  for (const [source, target] of [
    ["wasm/resvg.wasm", "resvg.wasm"],
    ["fonts/NanumSquareR.ttf", "NanumSquareR.ttf"],
    ["fonts/NanumSquareB.ttf", "NanumSquareB.ttf"],
    ["fonts/LICENSE-NanumSquare.txt", "LICENSE-NanumSquare.txt"],
  ]) copyFileSync(join(root, source), join(folder, "_assets", target));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareSupabaseAssets();
  console.log("Supabase WASM·폰트 자산과 의존성 버전을 준비했습니다.");
}
