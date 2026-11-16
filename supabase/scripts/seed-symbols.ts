import { logEvent } from "../../src/core/log.ts";
import { argumentsFor, main, operationsClient, seedFile } from "./client.ts";
import { seedSymbols } from "./operations.ts";

await main("seed", async () => {
  const args = argumentsFor("seed");
  if (args.help) { console.log("npm run seed:symbols:supabase -- [--project-ref <ref>] [--file <symbols.json>]"); return; }
  const count = await seedSymbols(operationsClient(args.projectRef), seedFile(args.file));
  logEvent("log", "chart.symbols.seeded", { "chart.symbols.count": count });
});
