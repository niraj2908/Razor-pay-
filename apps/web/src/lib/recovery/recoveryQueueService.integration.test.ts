import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { listRecoveryQueue } from "./recoveryQueueService";

/**
 * Real-database integration test for the Phase 25 Step 3 Recovery Queue
 * query service. A MOCK ALONE IS NOT SUFFICIENT to prove tenant isolation
 * (Phase 25 Step 3 Section 13) - this file proves it against two real,
 * distinct Merchant rows with real RevenueRiskEvent/Payment/Decision data.
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-step3-queue-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdPaymentIds: string[] = [];

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Recovery queue test merchant ${TAG}-${randomUUID()}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeRiskEvent(opts: {
  merchantId: string;
  diagnosis?: "CONFIRMED_FAILURE" | "PENDING" | "STATE_UNCERTAIN" | "CUSTOMER_ABANDONMENT" | "NETWORK_DEGRADATION" | "OTHER_RECOVERABLE";
  amountAtRisk?: number;
  resolvedAt?: Date | null;
  detectedAt?: Date;
  withDecision?: { decisionType: "ACT" | "WAIT" | "STOP" | "ESCALATE"; expectedIncrementalValue?: number };
}) {
  const payment = await prisma.payment.create({
    data: { merchantId: opts.merchantId, amount: 10000, currency: "INR", status: "FAILED", method: "card" },
  });
  createdPaymentIds.push(payment.id);

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: opts.merchantId,
      paymentId: payment.id,
      diagnosis: opts.diagnosis ?? "CUSTOMER_ABANDONMENT",
      amountAtRisk: opts.amountAtRisk ?? 10000,
      naturalRecoveryProbability: 0.3,
      dataSource: "SIMULATED",
      detectedAt: opts.detectedAt ?? new Date(),
      resolvedAt: opts.resolvedAt ?? null,
    },
  });

  if (opts.withDecision) {
    let chosenActionId: string | null = null;
    if (opts.withDecision.decisionType === "ACT") {
      const action = await prisma.candidateAction.create({
        data: {
          revenueRiskEventId: riskEvent.id,
          actionType: "PAYMENT_LINK",
          predictedSuccessProbability: 0.6,
          incrementalLift: 0.3,
          estimatedCost: 0,
          expectedNetValue: opts.withDecision.expectedIncrementalValue ?? 5000,
        },
      });
      chosenActionId = action.id;
    }
    await prisma.decision.create({
      data: {
        revenueRiskEventId: riskEvent.id,
        decisionType: opts.withDecision.decisionType,
        chosenActionId,
        expectedIncrementalValue: opts.withDecision.expectedIncrementalValue ?? null,
      },
    });
  }

  return riskEvent;
}

afterAll(async () => {
  await prisma.candidateAction.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("listRecoveryQueue against a real database", () => {
  it("CRITICAL: Merchant A's queue never contains Merchant B's records, even though both have real data", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();

    const riskA = await makeRiskEvent({ merchantId: merchantA.id, withDecision: { decisionType: "ACT" } });
    const riskB = await makeRiskEvent({ merchantId: merchantB.id, withDecision: { decisionType: "ACT" } });

    const queueA = await listRecoveryQueue(merchantA.id, { status: "all" });
    const queueB = await listRecoveryQueue(merchantB.id, { status: "all" });

    expect(queueA.items.map((i) => i.id)).toContain(riskA.id);
    expect(queueA.items.map((i) => i.id)).not.toContain(riskB.id);

    expect(queueB.items.map((i) => i.id)).toContain(riskB.id);
    expect(queueB.items.map((i) => i.id)).not.toContain(riskA.id);
  }, 30_000);

  it("an empty queue (merchant with zero risk events) returns an empty array, not an error", async () => {
    const emptyMerchant = await makeMerchant();
    const result = await listRecoveryQueue(emptyMerchant.id, {});
    expect(result).toEqual({ items: [], nextCursor: null });
  }, 30_000);

  it("status=open excludes resolved risk events by default", async () => {
    const merchant = await makeMerchant();
    const open = await makeRiskEvent({ merchantId: merchant.id, resolvedAt: null });
    const resolved = await makeRiskEvent({ merchantId: merchant.id, resolvedAt: new Date() });

    const result = await listRecoveryQueue(merchant.id, { status: "open" });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(open.id);
    expect(ids).not.toContain(resolved.id);
  }, 30_000);

  it("diagnosis filter narrows to the real, matching rows only", async () => {
    const merchant = await makeMerchant();
    const abandonment = await makeRiskEvent({ merchantId: merchant.id, diagnosis: "CUSTOMER_ABANDONMENT" });
    const network = await makeRiskEvent({ merchantId: merchant.id, diagnosis: "NETWORK_DEGRADATION" });

    const result = await listRecoveryQueue(merchant.id, { status: "all", diagnosis: "CUSTOMER_ABANDONMENT" });
    const ids = result.items.map((i) => i.id);
    expect(ids).toContain(abandonment.id);
    expect(ids).not.toContain(network.id);
  }, 30_000);

  it("deterministic ordering and real cursor pagination walk the full set exactly once each", async () => {
    const merchant = await makeMerchant();
    const base = new Date("2026-02-01T00:00:00.000Z");
    const created = [];
    for (let i = 0; i < 5; i++) {
      created.push(await makeRiskEvent({ merchantId: merchant.id, detectedAt: new Date(base.getTime() + i * 60_000) }));
    }

    const page1 = await listRecoveryQueue(merchant.id, { status: "all", sort: "detectedAt_asc", limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual([created[0].id, created[1].id]);
    expect(page1.nextCursor).not.toBeNull();

    const page2 = await listRecoveryQueue(merchant.id, { status: "all", sort: "detectedAt_asc", limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([created[2].id, created[3].id]);

    const page3 = await listRecoveryQueue(merchant.id, { status: "all", sort: "detectedAt_asc", limit: 2, cursor: page2.nextCursor! });
    expect(page3.items.map((i) => i.id)).toEqual([created[4].id]);
    expect(page3.nextCursor).toBeNull(); // reached the end
  }, 30_000);

  it("real integer-paise amounts round-trip exactly, and confidence is null when no action was chosen (WAIT)", async () => {
    const merchant = await makeMerchant();
    const waitEvent = await makeRiskEvent({ merchantId: merchant.id, amountAtRisk: 123456, withDecision: { decisionType: "WAIT" } });

    const result = await listRecoveryQueue(merchant.id, { status: "all" });
    const item = result.items.find((i) => i.id === waitEvent.id);
    expect(item?.amountAtRiskPaise).toBe(123456);
    expect(item?.decision?.decisionType).toBe("WAIT");
    expect(item?.decision?.chosenAction).toBeNull(); // WAIT never has a chosen action - never fabricated
  }, 30_000);
});
