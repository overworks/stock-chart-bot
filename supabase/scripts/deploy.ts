import { prepareSupabaseAssets } from "../../scripts/prepare-supabase.ts";
import { logEvent } from "../../src/core/log.ts";
import { argumentsFor, main, operationsClient, projectRef, requireCli, runCli, seedFile } from "./client.ts";
import { parseSeed, seedSymbols } from "./operations.ts";

await main("deploy", async () => {
  const args = argumentsFor("deploy");
  if (args.help) { console.log("npm run deploy:supabase -- --project-ref <ref> (또는 SUPABASE_PROJECT_REF 환경변수)"); return; }
  const ref = projectRef(args.projectRef, true)!;
  requireCli();
  const entries = parseSeed(seedFile());
  const client = operationsClient(ref);
  prepareSupabaseAssets();
  runCli(["db", "push", `--remote=${ref}`, "--skip-vault", "--yes"]);
  const count = await seedSymbols(client, entries, { onlyIfMissing: true });
  logEvent("log", "chart.symbols.bootstrapped", { "chart.symbols.count": count });
  runCli(["functions", "deploy", "stock-chart-bot", `--remote=${ref}`, "--yes"]);
});
