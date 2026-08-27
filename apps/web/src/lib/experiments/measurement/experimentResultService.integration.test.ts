import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { computeExperimentResult } from "./experimentResultService";

/**
 * Real-database integration test for the Phase 24 Step 2C orchestrator.
 * Builds one synthetic experiment covering every scenario the pure layers
 * were designed for - customer-level CONTROL, customer-level TREATMENT
 * with multiple candidates, a guest (CANDIDATE-unit) success, a guest
 * failure, an immature (not-yet-mature) candidate, a contaminated CONTROL
 * observation, and a second, unrelated experiment whose data must never be
 * combined into this one's result (isolation).
 *
 * Only real Postgres is touched here - RazorpayClient is never called and
 * no real/live payment data is used anywhere; every row is a clearly
 * tagged synthetic fixture, cleaned up in afterAll. Run via
 * `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase24-step2c-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdExperimentIds: string[] = [];

const EXPERIMENT_STARTED_AT = new Date("2020-01-01T00:00:00.000Z");
const EXPERIMENT_ENDED_AT = new Date("2025-01-01T00:00:00.000Z"); // safely after every fixture timestamp below
const MATURE_ASSIGNED_AT = new Date("2024-01-01T00:00:00.000Z");
const MATURE_DECIDED_AT = new Date("2024-01-01T00:10:00.000Z");
const NOW = new Date("2024-06-01T00:00:00.000Z"); // safely after every mature decidedAt

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Measurement orchestrator merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

/**
 * computeExperimentResult() never calls resolveExperimentAssignment() - it
 * only reads whatever ExperimentAssignment rows already exist for the
 * requested experimentId (simulating already-collected historical data),
 * so this fixture never needs a RUNNING experiment at all. Deliberately
 * created COMPLETED from the start: resolveExperimentAssignment's own
 * "earliest-started RUNNING experiment" tie-break policy (Phase 23 Step 5)
 * scans the ENTIRE shared real-database RUNNING population globally, so a
 * RUNNING experiment here - even briefly - would risk hijacking (or being
 * hijacked by) other integration test files' assignment-resolution
 * queries running concurrently against the same database. COMPLETED
 * avoids that class of cross-file contamination at its root rather than
 * racing an afterEach cleanup against concurrent test workers.
 */
async function makeExperiment(merchantId: string, treatmentAllocationPercent = 50) {
  const experiment = await prisma.experiment.create({
    data: {
      name: `Measurement orchestrator experiment ${TAG}-${randomUUID()}`,
      version: "v1",
      treatmentDefinition: "policy-v1",
      status: "COMPLETED",
      treatmentAllocationPercent,
      startedAt: EXPERIMENT_STARTED_AT,
      endedAt: EXPERIMENT_ENDED_AT,
    },
  });
  createdExperimentIds.push(experiment.id);
  void merchantId;
  return experiment;
}

async function makeCandidate(opts: {
  merchantId: string;
  customerId?: string;
  arm: "CONTROL" | "TREATMENT";
  experimentId: string;
  unitType: "CUSTOMER" | "CANDIDATE";
  unitKey: string;
  outcome?: { status: "RECOVERED" | "NOT_RECOVERED"; attributionStatus?: "NATURAL_RECOVERY" | "INTERVENTION_RECOVERY"; recoveredAmount?: number };
  withExecution?: boolean;
  decidedAt?: Date;
  assignedAt?: Date;
  reuseAssignmentId?: string;
}) {
  const payment = await prisma.payment.create({
    data: { merchantId: opts.merchantId, customerId: opts.customerId, amount: 10000, currency: "INR", status: "FAILED" },
  });

  let assignmentId = opts.reuseAssignmentId;
  if (!assignmentId) {
    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: opts.experimentId,
        unitType: opts.unitType,
        unitKey: opts.unitKey,
        arm: opts.arm,
        assignedAt: opts.assignedAt ?? MATURE_ASSIGNED_AT,
        eligibilityVersion: "eligibility-v1",
        assignmentAlgorithm: "sha256-v1",
      },
    });
    assignmentId = assignment.id;
  }

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: opts.merchantId,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
      experimentAssignmentId: assignmentId,
    },
  });

  const decision = await prisma.decision.create({
    data: {
      revenueRiskEventId: riskEvent.id,
      decisionType: opts.withExecution ? "ACT" : "WAIT",
      decidedAt: opts.decidedAt ?? MATURE_DECIDED_AT,
    },
  });

  if (opts.withExecution) {
    await prisma.execution.create({
      data: { decisionId: decision.id, paymentId: payment.id, actionType: "PAYMENT_LINK", status: "SUCCEEDED" },
    });
  }

  if (opts.outcome) {
    await prisma.outcome.create({
      data: {
        decisionId: decision.id,
        paymentId: payment.id,
        status: opts.outcome.status,
        attributionStatus: opts.outcome.attributionStatus ?? null,
        recoveredAmount: opts.outcome.recoveredAmount ?? null,
        attributionPolicyVersion: "attribution-v1",
      },
    });
  }

  return { paymentId: payment.id, riskEventId: riskEvent.id, decisionId: decision.id, assignmentId };
}

afterAll(async () => {
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.customer.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.$disconnect();
});

describe("computeExperimentResult against a real database", () => {
  it("computes a full, correctly-isolated result across a synthetic multi-scenario experiment", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeExperiment(merchant.id);

    // 1. Customer-level CONTROL, natural recovery (SUCCESS, 5000 paise).
    const customerA = await prisma.customer.create({ data: { merchantId: merchant.id, razorpayCustomerId: `${TAG}-custA` } });
    await makeCandidate({
      merchantId: merchant.id,
      customerId: customerA.id,
      arm: "CONTROL",
      experimentId: experiment.id,
      unitType: "CUSTOMER",
      unitKey: customerA.id,
      outcome: { status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 5000 },
    });

    // 2. Customer-level TREATMENT with TWO candidates - one success, one
    // failure - must roll up into exactly ONE analysis unit (SUCCESS, 3000).
    const customerB = await prisma.customer.create({ data: { merchantId: merchant.id, razorpayCustomerId: `${TAG}-custB` } });
    const first = await makeCandidate({
      merchantId: merchant.id,
      customerId: customerB.id,
      arm: "TREATMENT",
      experimentId: experiment.id,
      unitType: "CUSTOMER",
      unitKey: customerB.id,
      withExecution: true,
      outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 3000 },
    });
    await makeCandidate({
      merchantId: merchant.id,
      customerId: customerB.id,
      arm: "TREATMENT",
      experimentId: experiment.id,
      unitType: "CUSTOMER",
      unitKey: customerB.id,
      reuseAssignmentId: first.assignmentId, // SAME customer -> SAME assignment, per Phase 23's design
      outcome: { status: "NOT_RECOVERED" },
    });

    // 3. Guest (CANDIDATE-unit) TREATMENT success (2000 paise).
    const guestSuccess = await makeCandidate({
      merchantId: merchant.id,
      arm: "TREATMENT",
      experimentId: experiment.id,
      unitType: "CANDIDATE",
      unitKey: `${TAG}-guest-success`,
      withExecution: true,
      outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 2000 },
    });

    // 4. Guest CONTROL failure.
    await makeCandidate({
      merchantId: merchant.id,
      arm: "CONTROL",
      experimentId: experiment.id,
      unitType: "CANDIDATE",
      unitKey: `${TAG}-guest-failure`,
      outcome: { status: "NOT_RECOVERED" },
    });

    // 5. Immature CONTROL candidate - decided right at `now`, no Outcome
    // row at all yet. Must NEVER be counted as a failure.
    await makeCandidate({
      merchantId: merchant.id,
      arm: "CONTROL",
      experimentId: experiment.id,
      unitType: "CANDIDATE",
      unitKey: `${TAG}-guest-immature`,
      decidedAt: NOW,
      assignedAt: new Date(NOW.getTime() - 60_000),
    });

    // 6. Contaminated CONTROL - has a real Execution row despite CONTROL
    // arm. Must be flagged, never silently reassigned to TREATMENT.
    await makeCandidate({
      merchantId: merchant.id,
      arm: "CONTROL",
      experimentId: experiment.id,
      unitType: "CANDIDATE",
      unitKey: `${TAG}-guest-contaminated`,
      withExecution: true,
    });

    // 7. An entirely SEPARATE experiment's data - must never be combined
    // into experiment.id's result (isolation).
    const otherExperiment = await makeExperiment(merchant.id);
    await makeCandidate({
      merchantId: merchant.id,
      arm: "TREATMENT",
      experimentId: otherExperiment.id,
      unitType: "CANDIDATE",
      unitKey: `${TAG}-other-experiment-guest`,
      withExecution: true,
      outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 999999 },
    });

    const outcome = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });

    expect(outcome.status).toBe("computed");
    if (outcome.status !== "computed") return;
    const { result } = outcome;

    // TREATMENT: customerB unit (SUCCESS, 3000) + guest success (SUCCESS, 2000) = 2 analyzable, 2 successes, GMV 5000.
    expect(result.treatment.recoveryRate).toMatchObject({ analyzableUnits: 2, successes: 2, failures: 0, rate: 1 });
    expect(result.treatment.gmv.recoveredGMV).toBe(5000);

    // CONTROL: customerA (SUCCESS, 5000) + guest failure (FAILURE) = 2 analyzable, 1 success, 1 failure.
    // Immature and contaminated observations are excluded, never counted as failures.
    expect(result.control.recoveryRate).toMatchObject({ analyzableUnits: 2, successes: 1, failures: 1, rate: 0.5 });
    expect(result.control.gmv.recoveredGMV).toBe(5000);

    // The other experiment's 999999-paise "recovery" must never appear anywhere in this result.
    expect(result.treatment.gmv.recoveredGMV).not.toBe(999999);
    expect(JSON.stringify(result)).not.toContain("999999");

    // Contamination is reported, not hidden, and the isolation/uniqueness/timing checks all pass cleanly.
    const contamination = result.validity.checks.find((c) => c.code === "control_contamination");
    expect(contamination).toMatchObject({ passed: false, details: { affectedUnits: 1 } });
    expect(result.validity.status).toBe("INVALID"); // contamination present -> correctly INVALID, not silently VALID

    const immature = result.validity.checks.find((c) => c.code === "immature_observations");
    expect(immature?.details?.notYetMatureCount).toBe(1);

    const isolation = result.validity.checks.find((c) => c.code === "experiment_isolation");
    expect(isolation).toMatchObject({ passed: true });

    expect(result.observedDifference.status).toBe("computed");
    if (result.observedDifference.status === "computed") {
      expect(result.observedDifference.observedDifference).toBeCloseTo(0.5, 10); // 1.0 - 0.5
    }

    void guestSuccess;
  }, 30_000);

  it("returns experiment_not_found for a nonexistent experiment id without throwing", async () => {
    const outcome = await computeExperimentResult("does_not_exist", 0.95);
    expect(outcome).toEqual({ status: "experiment_not_found" });
  });
});
