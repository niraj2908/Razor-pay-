import { prisma } from "@/lib/db";
import { seedDemoWorkspace } from "./seedDemoWorkspace";
import { resetDemoWorkspace } from "./resetDemoWorkspace";

/**
 * Manual, explicit CLI for the Demo Workspace (Phase 28B). Never invoked
 * automatically by the app, a build, or a deploy - only ever run by an
 * operator via `pnpm db:seed:demo` / `pnpm db:reset:demo` / `pnpm db:reseed:demo`.
 *
 * Prints which database it is about to touch (host only, never credentials)
 * before doing anything, since running this against the wrong `DATABASE_URL`
 * is the single highest-risk mistake here.
 */
function printTargetDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const hostMatch = url.match(/@([^/]+)\//);
  console.log(`[demo] target database host: ${hostMatch ? hostMatch[1] : "(unable to parse DATABASE_URL host)"}`);
}

async function main() {
  const command = process.argv[2];
  printTargetDatabase();

  if (command === "seed") {
    const result = await seedDemoWorkspace();
    console.log("[demo] seed result:", result);
    if (result.status === "unsafe") {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "reset") {
    const result = await resetDemoWorkspace();
    console.log("[demo] reset result:", result);
    return;
  }

  if (command === "reseed") {
    const resetResult = await resetDemoWorkspace();
    console.log("[demo] reset result:", resetResult);
    const seedResult = await seedDemoWorkspace();
    console.log("[demo] seed result:", seedResult);
    if (seedResult.status === "unsafe") {
      process.exitCode = 1;
    }
    return;
  }

  console.error('[demo] usage: tsx src/lib/demo/cli.ts <seed|reset|reseed>');
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("[demo] fatal error:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
