import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { resolveExperimentAssignment } from "./experimentService";

/**
 * Real-database integration tests for Phase 23 Step 5 experiment
 * assignment, extended in Phase 25 Step 5 to cover per-merchant experiment
 * scoping: concurrency, duplicate-request idempotency, real unique
 * constraint enforcement, and cross-merchant isolation can only be proven
 * against real Postgres. Run via `pnpm test:integration`, never as part of
 * `pnpm test`.
 *
 * Every row here is a clearly-marked fixture, cleaned up in afterAll. No
 * real experiment is created or "launched" by these tests - each is a
 * throwaway mechanism-validation fixture, exactly like every other
 * integration test in this codebase (idempotency.integration.test.ts,
 * outcomeService.integration.test.ts, etc.).
 */

const TAG = `phase25-step5-${randomUUID()}`;
const createdExperimentIds: string[] = [];
const createdMerchantIds: string[] = [];

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Assignment test merchant ${TAG}-${randomUUID()}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeRunningExperiment(merchantId: string, treatmentAllocationPercent: number, startedAt: Date = new Date()) {
  const experiment = await prisma.experiment.create({
    data: {
      merchantId,
      name: `Assignment test experiment ${TAG}`,
      version: "v1",
      treatmentDefinition: "policy-v1",
      status: "RUNNING",
      treatmentAllocationPercent,
      startedAt,
    },
  });
  createdExperimentIds.push(experiment.id);
  return experiment;
}

// `resolveExperimentAssignment` now picks the earliest-started RUNNING
// experiment PER MERCHANT (Phase 25 Step 5 - previously a global tie-break,
// Section 14's original documented policy). Since every test in this file
// shares one real database, a RUNNING experiment left behind by an earlier
// test COULD still contaminate a later test that reuses the SAME merchant -
// each test below creates its own fresh merchant specifically to avoid
// needing to rely on this afterEach alone, but it is kept as defense in
// depth for any test that does share a merchant across assertions.
afterEach(async () => {
  if (createdExperimentIds.length > 0) {
    await prisma.experiment.updateMany({
      where: { id: { in: createdExperimentIds } },
      data: { status: "COMPLETED", endedAt: new Date() },
    });
  }
});

afterAll(async () => {
  // Scoped to THIS file's own assignments, resolved before they are
  // deleted. A blanket delete on `entityType: "ExperimentAssignment"`
  // would take out every assignment audit row in the shared database -
  // including the demo workspace's and any other suite's, mid-run.
  const assignmentIds = await prisma.experimentAssignment
    .findMany({ where: { experimentId: { in: createdExperimentIds } }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id));
  await prisma.auditEvent.deleteMany({
    where: { entityType: "ExperimentAssignment", entityId: { in: assignmentIds } },
  });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.customer.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("resolveExperimentAssignment against a real database", () => {
  it("9. processing the same participant twice never creates a second ExperimentAssignment", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeRunningExperiment(merchant.id, 100);
    const customerId = `${TAG}-cust-dup`;

    const first = await resolveExperimentAssignment({ customerId, candidateKey: "risk_a", paymentState: "FAILED", merchantId: merchant.id });
    const second = await resolveExperimentAssignment({ customerId, candidateKey: "risk_b", paymentState: "FAILED", merchantId: merchant.id });

    expect(first.outcome).toBe("assigned");
    expect(second.outcome).toBe("assigned");

    const rows = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id, unitType: "CUSTOMER", unitKey: customerId },
    });
    expect(rows).toHaveLength(1);
  }, 20_000);

  it("10. five concurrent assignment requests for the same participant converge on exactly one row (real P2002)", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeRunningExperiment(merchant.id, 100);
    const customerId = `${TAG}-cust-concurrent`;

    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        resolveExperimentAssignment({ customerId, candidateKey: `risk_${i}`, paymentState: "FAILED", merchantId: merchant.id })
      )
    );
    for (const r of results) expect(r.outcome).toBe("assigned");

    const rows = await prisma.experimentAssignment.findMany({
      where: { experimentId: experiment.id, unitType: "CUSTOMER", unitKey: customerId },
    });
    expect(rows).toHaveLength(1);

    const arms = new Set(
      results.map((r) => (r.outcome === "assigned" ? r.assignment.arm : null))
    );
    expect(arms.size).toBe(1); // every concurrent caller sees the SAME arm
  }, 20_000);

  it("CRITICAL (Phase 25 Step 5): a RUNNING experiment belonging to a DIFFERENT real merchant never applies, even when it is the globally-earliest-started RUNNING experiment", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();
    // Deliberately far earlier than anything merchant A creates - under the
    // OLD global tie-break policy this would have won and been (wrongly)
    // applied to merchant A's candidate.
    await makeRunningExperiment(merchantB.id, 100, new Date("2000-01-01T00:00:00.000Z"));

    const result = await resolveExperimentAssignment({
      customerId: `${TAG}-cust-isolated`,
      candidateKey: `${TAG}-risk-isolated`,
      paymentState: "FAILED",
      merchantId: merchantA.id,
    });

    expect(result).toEqual({ outcome: "no_running_experiment" });
  }, 20_000);

  it("CRITICAL (Phase 25 Step 5): two merchants running experiments concurrently are each assigned into their OWN experiment only", async () => {
    const merchantA = await makeMerchant();
    const merchantB = await makeMerchant();
    const experimentA = await makeRunningExperiment(merchantA.id, 100);
    const experimentB = await makeRunningExperiment(merchantB.id, 100, new Date("2000-01-01T00:00:00.000Z")); // earlier, but a different merchant

    const resultA = await resolveExperimentAssignment({
      customerId: `${TAG}-cust-a`,
      candidateKey: `${TAG}-risk-a`,
      paymentState: "FAILED",
      merchantId: merchantA.id,
    });
    const resultB = await resolveExperimentAssignment({
      customerId: `${TAG}-cust-b`,
      candidateKey: `${TAG}-risk-b`,
      paymentState: "FAILED",
      merchantId: merchantB.id,
    });

    expect(resultA.outcome).toBe("assigned");
    expect(resultB.outcome).toBe("assigned");
    if (resultA.outcome === "assigned") expect(resultA.assignment.experimentId).toBe(experimentA.id);
    if (resultB.outcome === "assigned") expect(resultB.assignment.experimentId).toBe(experimentB.id);
  }, 20_000);

  it("17. assignment timestamp is strictly no later than the Decision it precedes", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeRunningExperiment(merchant.id, 100);
    const payment = await prisma.payment.create({
      data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: "FAILED" },
    });

    // Mirrors candidateBuilder.ts's real sequencing: assignment is resolved
    // and persisted FIRST (its own round trip), and only afterwards is the
    // RevenueRiskEvent/Decision pair created - never the reverse.
    const resolution = await resolveExperimentAssignment({
      customerId: null,
      candidateKey: `${TAG}-risk-timing`,
      paymentState: payment.status,
      merchantId: merchant.id,
    });
    expect(resolution.outcome).toBe("assigned");
    const assignedAt = resolution.outcome === "assigned" ? resolution.assignment.assignedAt : null;

    const riskEvent = await prisma.revenueRiskEvent.create({
      data: {
        merchantId: merchant.id,
        paymentId: payment.id,
        diagnosis: "CUSTOMER_ABANDONMENT",
        amountAtRisk: 10000,
        dataSource: "SIMULATED",
        experimentAssignmentId: resolution.outcome === "assigned" ? resolution.assignment.id : null,
      },
    });
    const decision = await prisma.decision.create({
      data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", expectedIncrementalValue: 50 },
    });

    expect(assignedAt).not.toBeNull();
    // <= rather than strict < : two independent, sequential DB round trips
    // will virtually always land in different microseconds, but this
    // asserts the actual causal guarantee ("assignment was never created
    // after the decision it precedes") without being flaky against
    // millisecond-resolution timestamp ties.
    expect(assignedAt!.getTime()).toBeLessThanOrEqual(decision.decidedAt.getTime());
    void experiment;
  }, 20_000);

  it("11. a CUSTOMER-level assignment is reused across multiple real recovery candidates for the same customer", async () => {
    const merchant = await makeMerchant();
    await makeRunningExperiment(merchant.id, 100);
    const customer = await prisma.customer.create({
      data: { merchantId: merchant.id, razorpayCustomerId: `${TAG}-cust` },
    });

    const first = await resolveExperimentAssignment({
      customerId: customer.id,
      candidateKey: `${TAG}-risk-1`,
      paymentState: "FAILED",
      merchantId: merchant.id,
    });
    const second = await resolveExperimentAssignment({
      customerId: customer.id,
      candidateKey: `${TAG}-risk-2`,
      paymentState: "FAILED",
      merchantId: merchant.id,
    });

    expect(first.outcome).toBe("assigned");
    expect(second.outcome).toBe("assigned");
    if (first.outcome === "assigned" && second.outcome === "assigned") {
      expect(second.assignment.id).toBe(first.assignment.id);
      expect(second.assignment.arm).toBe(first.assignment.arm);
    }
  }, 20_000);

  it("21. a customer already assigned to experiment A is excluded (not reassigned) when experiment B is also RUNNING for the same merchant", async () => {
    const merchant = await makeMerchant();
    const experimentA = await makeRunningExperiment(merchant.id, 100, new Date("2020-01-01T00:00:00.000Z"));
    const customerId = `${TAG}-cust-overlap`;
    const first = await resolveExperimentAssignment({
      customerId,
      candidateKey: `${TAG}-risk-a`,
      paymentState: "FAILED",
      merchantId: merchant.id,
    });
    expect(first.outcome).toBe("assigned");
    const firstExperimentId = first.outcome === "assigned" ? first.assignment.experimentId : null;
    expect(firstExperimentId).toBe(experimentA.id);

    // experimentB starts LATER, so the tie-break policy would otherwise
    // prefer experimentA anyway - the real point of this test is that the
    // customer's EXISTING assignment excludes them from experimentB
    // entirely, rather than silently reassigning them.
    const experimentB = await makeRunningExperiment(merchant.id, 100, new Date("2030-01-01T00:00:00.000Z"));
    void experimentB;

    const second = await resolveExperimentAssignment({
      customerId,
      candidateKey: `${TAG}-risk-b`,
      paymentState: "FAILED",
      merchantId: merchant.id,
    });
    expect(second.outcome).toBe("assigned");
    if (second.outcome === "assigned") {
      expect(second.assignment.experimentId).toBe(experimentA.id);
    }
  }, 20_000);

  it("20. Outcome joins deterministically back to the ExperimentAssignment via Decision -> RevenueRiskEvent", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeRunningExperiment(merchant.id, 0); // force CONTROL
    const payment = await prisma.payment.create({
      data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: "CAPTURED" },
    });

    const resolution = await resolveExperimentAssignment({
      customerId: null,
      candidateKey: `${TAG}-risk-join`,
      paymentState: "FAILED", // eligibility is evaluated on the pre-decision state, not the final CAPTURED state
      merchantId: merchant.id,
    });
    expect(resolution.outcome).toBe("assigned");
    const assignment = resolution.outcome === "assigned" ? resolution.assignment : null;
    expect(assignment!.arm).toBe("CONTROL");

    const riskEvent = await prisma.revenueRiskEvent.create({
      data: {
        merchantId: merchant.id,
        paymentId: payment.id,
        diagnosis: "CUSTOMER_ABANDONMENT",
        amountAtRisk: 10000,
        dataSource: "SIMULATED",
        experimentAssignmentId: assignment!.id,
      },
    });
    const decision = await prisma.decision.create({
      data: { revenueRiskEventId: riskEvent.id, decisionType: "WAIT" },
    });
    const outcome = await prisma.outcome.create({
      data: {
        decisionId: decision.id,
        paymentId: payment.id,
        status: "RECOVERED",
        attributionStatus: "NATURAL_RECOVERY",
        recoveredAmount: 10000,
        attributionPolicyVersion: "attribution-v1",
      },
    });

    const reloaded = await prisma.outcome.findUniqueOrThrow({
      where: { id: outcome.id },
      include: { decision: { include: { revenueRiskEvent: { include: { experimentAssignment: true } } } } },
    });
    expect(reloaded.decision.revenueRiskEvent.experimentAssignment?.arm).toBe("CONTROL");
    expect(reloaded.decision.revenueRiskEvent.experimentAssignment?.experimentId).toBe(experiment.id);
  }, 20_000);
});
