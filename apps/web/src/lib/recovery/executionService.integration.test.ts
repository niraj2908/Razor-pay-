import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { executeCommand } from "./executionService";

/**
 * A CONTROLLED, explicitly-invoked integration test against real Razorpay
 * Test Mode (Phase 22 Step 3, section 14/15). This does NOT run as part of
 * `pnpm test` - only `pnpm test:integration` (see vitest.integration.config.ts).
 *
 * The flow under test is exactly:
 *   test command -> Execution Service -> Razorpay Adapter -> Razorpay Test Mode
 * This file never calls RazorpayClient directly - only executeCommand().
 *
 * Uses RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET already present in the local
 * environment; their values are never read or logged here beyond what the
 * adapter itself does internally.
 *
 * IMPORTANT: creating a Payment Link here is NOT the same as recovering
 * revenue. This proves the link was created via our real execution path -
 * it does not simulate or claim a customer paid it.
 */

let merchantId: string;
let paymentId: string;
let revenueRiskEventId: string;
let decisionId: string;

const TEST_AMOUNT_PAISE = 100; // ₹1 - a controlled, minimal test amount

beforeAll(async () => {
  const merchant = await prisma.merchant.create({
    data: { name: `Integration Test Merchant ${randomUUID()}` },
  });
  merchantId = merchant.id;

  const payment = await prisma.payment.create({
    data: {
      merchantId,
      amount: TEST_AMOUNT_PAISE,
      currency: "INR",
      status: "FAILED",
      method: "card",
    },
  });
  paymentId = payment.id;

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId,
      paymentId,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: TEST_AMOUNT_PAISE,
      // This RevenueRiskEvent/Payment is fabricated by this test, not a
      // real customer's failed payment - SIMULATED is the honest tag, even
      // though the Razorpay call it drives is against real Test Mode.
      dataSource: "SIMULATED",
    },
  });
  revenueRiskEventId = riskEvent.id;

  const decision = await prisma.decision.create({
    data: {
      revenueRiskEventId,
      decisionType: "ACT",
      expectedIncrementalValue: 50,
    },
  });
  decisionId = decision.id;
});

afterAll(async () => {
  // Clean up our database rows. The Razorpay Test Mode Payment Link
  // created against real Test Mode is deliberately left as-is - it is
  // harmless (no real money, Test Mode only) and this codebase has no
  // cancel-payment-link adapter method yet.
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: await executionIdsForCleanup() } } });
  await prisma.execution.deleteMany({ where: { decisionId } });
  await prisma.decision.deleteMany({ where: { id: decisionId } });
  await prisma.revenueRiskEvent.deleteMany({ where: { id: revenueRiskEventId } });
  await prisma.payment.deleteMany({ where: { id: paymentId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.$disconnect();
});

async function executionIdsForCleanup(): Promise<string[]> {
  const executions = await prisma.execution.findMany({ where: { decisionId }, select: { id: true } });
  return executions.map((e) => e.id);
}

describe("executeCommand against real Razorpay Test Mode", () => {
  it("creates a real Payment Link via our Execution Service and records SUCCEEDED", async () => {
    const result = await executeCommand({
      decisionId,
      paymentId,
      action: "ACT",
      strategy: "PAYMENT_LINK",
      policyVersion: "policy-v1",
      decidedAt: new Date().toISOString(),
      amount: TEST_AMOUNT_PAISE,
    });

    expect(result.status).toBe("succeeded");
    if (result.status !== "succeeded") return;

    expect(result.razorpayReferenceId).toMatch(/^plink_/);

    const execution = await prisma.execution.findUniqueOrThrow({ where: { decisionId } });
    expect(execution.status).toBe("SUCCEEDED");
    expect(execution.razorpayReferenceId).toBe(result.razorpayReferenceId);
    expect(execution.completedAt).not.toBeNull();

    const auditEvents = await prisma.auditEvent.findMany({
      where: { entityType: "Execution", entityId: execution.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = auditEvents.map((e) => e.action);
    expect(actions).toContain("execution.requested");
    expect(actions).toContain("execution.started");
    expect(actions).toContain("execution.succeeded");

    // No secret should ever appear in any persisted audit detail.
    const serialized = JSON.stringify(auditEvents.map((e) => e.details));
    expect(serialized).not.toMatch(/RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|Basic [A-Za-z0-9+/=]/);
  }, 20_000);
});
