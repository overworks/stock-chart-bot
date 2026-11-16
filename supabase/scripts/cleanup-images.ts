import { logEvent } from "../../src/core/log.ts";
import { argumentsFor, main, operationsClient } from "./client.ts";
import { cleanupImages } from "./operations.ts";

await main("cleanup", async () => {
  const args = argumentsFor("cleanup");
  if (args.help) { console.log("npm run cleanup:images:supabase -- [--project-ref <ref>] [--dry-run]"); return; }
  const result = await cleanupImages(operationsClient(args.projectRef), { dryRun: args.dryRun });
  logEvent("log", "chart.images.cleaned", {
    "chart.images.scanned": result.scanned, "chart.images.expired": result.expired,
    "chart.images.deleted": result.deleted, "chart.images.cutoff": result.cutoff, "chart.images.dry_run": result.dryRun,
  });
});
