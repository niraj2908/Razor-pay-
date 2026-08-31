import { prisma } from "@/lib/db";
import { provisionRazorpayTestWorkspace } from "./provisionWorkspace";

/**
 * Manual, explicit CLI for provisioning the Razorpay Test Mode workspace
 * (Phase 29). Never invoked by the app, a build, or a deploy - only ever
 * run deliberately via `pnpm db:provision:razorpay-test`.
 *
 * Prints the target database HOST only (never credentials), for the same
 * reason the demo CLI does: running this against the wrong DATABASE_URL is
 * the highest-risk mistake available here.
 *
 * Deliberately prints the merchant id: it is not a secret, and the operator
 * needs it to set RAZORPAY_MERCHANT_ID. The operator PASSWORD is never
 * printed - it comes from, and stays in, the environment.
 */
function printTargetDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  const hostMatch = url.match(/@([^/]+)\//);
  console.log(`[razorpay-test] target database host: ${hostMatch ? hostMatch[1] : "(unable to parse DATABASE_URL host)"}`);
}

async function main() {
  printTargetDatabase();

  const result = await provisionRazorpayTestWorkspace();
  console.log("[razorpay-test] result:", result);

  if (result.status === "unsafe") {
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log("[razorpay-test] Next step: set this in your environment (never commit it):");
  console.log(`[razorpay-test]   RAZORPAY_MERCHANT_ID=${result.merchantId}`);
  console.log("[razorpay-test] Until that is set, resolveConfiguredMerchant() fails closed and");
  console.log("[razorpay-test] no webhook can create a Payment - which is the intended safe default.");
}

main()
  .catch((error) => {
    console.error("[razorpay-test] failed:", error instanceof Error ? error.message : "unknown_error");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
