import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { computeExperimentResult } from "./experimentResultService";
import { persistExperimentResult } from "./experimentMeasurementResultService";

/**
 * Real-database integration test for the Phase 24 Step 4 persistence
 * service. Every ExperimentAnalysisResult fed into persistExperimentResult()
 * here comes from a REAL call to computeExperimentResult() against
 * synthetic, clearly-tagged fixtures - never a hand-built object - so the
 * unique-constraint, idempotency, and concurrency behavior is proven against
 * the actual ExperimentMeasurementResult table and its two real Postgres
 * unique indexes, not a mock.
 *
 * No RazorpayClient call, no live customer/payment data anywhere. Run via
 * `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase24-step4-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdExperimentIds: string[] = [];

const EXPERIMENT_STARTED_AT = new Date("2020-01-01T00:00:00.000Z");
const EXPERIMENT_ENDED_AT = new Date("2025-01-01T00:00:00.000Z");
const ASSIGNED_AT = new Date("2024-01-01T00:00:00.000Z");
const DECIDED_AT = new Date("2024-01-01T00:10:00.000Z");
const NOW = new Date("2024-06-01T00:00:00.000Z");

async function makeMerchant() {
  const merchant = await prisma.merchant.create({ data: { name: `Measurement persistence merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

/**
 * Same rationale as experimentResultService.integration.test.ts: created
 * COMPLETED from the start (or RUNNING only where the test specifically
 * exercises the INTERIM/RUNNING resultKind path, in which case it is never
 * left dangling since computeExperimentResult/persistExperimentResult never
 * call resolveExperimentAssignment and so cannot be hijacked by, or hijack,
 * that unrelated global "earliest RUNNING experiment" tie-break).
 */
async function makeExperiment(merchantId: string, status: "RUNNING" | "COMPLETED" = "COMPLETED") {
  const experiment = await prisma.experiment.create({
    data: {
      merchantId,
      name: `Measurement persistence experiment ${TAG}-${randomUUID()}`,
      version: "v1",
      treatmentDefinition: "policy-v1",
      status,
      treatmentAllocationPercent: 50,
      startedAt: EXPERIMENT_STARTED_AT,
      endedAt: status === "COMPLETED" ? EXPERIMENT_ENDED_AT : null,
    },
  });
  createdExperimentIds.push(experiment.id);
  return experiment;
}

async function makeCandidate(opts: {
  merchantId: string;
  arm: "CONTROL" | "TREATMENT";
  experimentId: string;
  unitKey: string;
  outcome?: { status: "RECOVERED" | "NOT_RECOVERED"; attributionStatus?: "NATURAL_RECOVERY" | "INTERVENTION_RECOVERY"; recoveredAmount?: number };
  withExecution?: boolean;
  decidedAt?: Date;
  assignedAt?: Date;
}) {
  const payment = await prisma.payment.create({
    data: { merchantId: opts.merchantId, amount: 10000, currency: "INR", status: "FAILED" },
  });

  const assignment = await prisma.experimentAssignment.create({
    data: {
      experimentId: opts.experimentId,
      unitType: "CANDIDATE",
      unitKey: opts.unitKey,
      arm: opts.arm,
      assignedAt: opts.assignedAt ?? ASSIGNED_AT,
      eligibilityVersion: "eligibility-v1",
      assignmentAlgorithm: "sha256-v1",
    },
  });

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: opts.merchantId,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
      experimentAssignmentId: assignment.id,
    },
  });

  const decision = await prisma.decision.create({
    data: {
      revenueRiskEventId: riskEvent.id,
      decisionType: opts.withExecution ? "ACT" : "WAIT",
      decidedAt: opts.decidedAt ?? DECIDED_AT,
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

  return { paymentId: payment.id };
}

/** Builds a clear, large TREATMENT-vs-CONTROL effect: N successes out of N
 * on TREATMENT, 0 out of N on CONTROL - the Newcombe-hybrid CI for this
 * separation clears a small (0.05) configured threshold easily, while still
 * being a completely ordinary, non-contaminated, fully mature dataset. */
async function makeCleanEffectExperiment(merchant: { id: string }, status: "RUNNING" | "COMPLETED", n = 5) {
  const experiment = await makeExperiment(merchant.id, status);
  // Each candidate's OWN chain of writes (payment -> assignment -> riskEvent
  // -> decision -> outcome) must stay sequential (FK dependencies), but
  // DIFFERENT candidates share no state and no unitKey, so they can be
  // created concurrently - this cuts real network round-trip time against
  // the remote Supabase database substantially without changing what data
  // ends up in the database.
  const creates: Promise<unknown>[] = [];
  for (let i = 0; i < n; i++) {
    creates.push(
      makeCandidate({
        merchantId: merchant.id,
        arm: "TREATMENT",
        experimentId: experiment.id,
        unitKey: `${TAG}-t-${experiment.id}-${i}`,
        withExecution: true,
        outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 1000 },
      })
    );
    creates.push(
      makeCandidate({
        merchantId: merchant.id,
        arm: "CONTROL",
        experimentId: experiment.id,
        unitKey: `${TAG}-c-${experiment.id}-${i}`,
        outcome: { status: "NOT_RECOVERED" },
      })
    );
  }
  await Promise.all(creates);
  return experiment;
}

async function makeInsufficientDataExperiment(merchant: { id: string }) {
  const experiment = await makeExperiment(merchant.id, "COMPLETED");
  // Only one analyzable unit per arm, with a configured minimum of 5 -
  // structurally sound, just not enough volume.
  await makeCandidate({
    merchantId: merchant.id,
    arm: "TREATMENT",
    experimentId: experiment.id,
    unitKey: `${TAG}-insuff-t-${experiment.id}`,
    outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 500 },
  });
  await makeCandidate({
    merchantId: merchant.id,
    arm: "CONTROL",
    experimentId: experiment.id,
    unitKey: `${TAG}-insuff-c-${experiment.id}`,
    outcome: { status: "NOT_RECOVERED" },
  });
  return experiment;
}

async function makeInvalidExperiment(merchant: { id: string }) {
  const experiment = await makeExperiment(merchant.id, "COMPLETED");
  await makeCandidate({
    merchantId: merchant.id,
    arm: "TREATMENT",
    experimentId: experiment.id,
    unitKey: `${TAG}-invalid-t-${experiment.id}`,
    withExecution: true,
    outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 500 },
  });
  // Contaminated CONTROL: an Execution row despite the CONTROL arm -> an
  // ERROR-severity check fails -> validity.status INVALID.
  await makeCandidate({
    merchantId: merchant.id,
    arm: "CONTROL",
    experimentId: experiment.id,
    unitKey: `${TAG}-invalid-c-${experiment.id}`,
    withExecution: true,
    outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 500 },
  });
  return experiment;
}

async function sourceRowCounts(merchantId: string, experimentId: string) {
  const [payments, riskEvents, decisions, executions, outcomes, assignments] = await Promise.all([
    prisma.payment.count({ where: { merchantId } }),
    prisma.revenueRiskEvent.count({ where: { merchantId } }),
    prisma.decision.count({ where: { revenueRiskEvent: { merchantId } } }),
    prisma.execution.count({ where: { decision: { revenueRiskEvent: { merchantId } } } }),
    prisma.outcome.count({ where: { decision: { revenueRiskEvent: { merchantId } } } }),
    prisma.experimentAssignment.count({ where: { experimentId } }),
  ]);
  return { payments, riskEvents, decisions, executions, outcomes, assignments };
}

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { entityType: "ExperimentMeasurementResult", entityId: { in: await prisma.experimentMeasurementResult.findMany({ where: { experimentId: { in: createdExperimentIds } }, select: { id: true } }).then((rows) => rows.map((r) => r.id)) } } });
  await prisma.experimentMeasurementResult.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.$disconnect();
});

describe("persistExperimentResult against a real database", () => {
  it("1/4/9. persists a VALID_EFFECT result, then a later recalculation with no threshold on the SAME experiment persists as a NEW VALID_INCONCLUSIVE snapshot (version 2)", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED");

    const computedT1 = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computedT1.status).toBe("computed");
    if (computedT1.status !== "computed") return;
    expect(computedT1.result.validity.status).toBe("VALID");

    const outcomeT1 = await persistExperimentResult(computedT1.result, { minimumRateDifference: 0.05 });
    expect(outcomeT1.status).toBe("created");
    if (outcomeT1.status !== "created") return;
    expect(outcomeT1.record.resultStatus).toBe("VALID_EFFECT");
    expect(outcomeT1.record.version).toBe(1);
    expect(outcomeT1.record.resultKind).toBe("FINAL"); // COMPLETED + no immature units

    // 9. A later recalculation (different `now` -> different dataCutoffAt)
    // is a DIFFERENT calculation identity -> a NEW snapshot, never an update.
    const later = new Date(NOW.getTime() + 60_000);
    const computedT2 = await computeExperimentResult(experiment.id, 0.95, { now: later, minimumAnalyzableSamplePerArm: 1 });
    expect(computedT2.status).toBe("computed");
    if (computedT2.status !== "computed") return;

    // 4. No threshold configured this time -> must NEVER become VALID_EFFECT
    // merely because the same large, clear effect is still present.
    const outcomeT2 = await persistExperimentResult(computedT2.result, null);
    expect(outcomeT2.status).toBe("created");
    if (outcomeT2.status !== "created") return;
    expect(outcomeT2.record.resultStatus).toBe("VALID_INCONCLUSIVE");
    expect(outcomeT2.record.version).toBe(2); // 7. distinct version for the same experiment
    expect(outcomeT2.record.id).not.toBe(outcomeT1.record.id);

    // The FIRST snapshot must remain byte-for-byte unchanged - immutability.
    const reread = await prisma.experimentMeasurementResult.findUniqueOrThrow({ where: { id: outcomeT1.record.id } });
    expect(reread.resultStatus).toBe("VALID_EFFECT");
    expect(reread.version).toBe(1);
  }, 90_000);

  it("2. persists an INSUFFICIENT_DATA result for an under-sampled experiment", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeInsufficientDataExperiment(merchant);

    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 5 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;
    expect(computed.result.validity.status).toBe("INSUFFICIENT_DATA");

    const outcome = await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.record.resultStatus).toBe("INSUFFICIENT_DATA");
  }, 60_000);

  it("3. persists an INVALID result for a contaminated experiment", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeInvalidExperiment(merchant);

    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;
    expect(computed.result.validity.status).toBe("INVALID");

    const outcome = await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.record.resultStatus).toBe("INVALID");
  }, 60_000);

  it("5/13/14. an idempotent duplicate persistence (same calculation identity) returns the SAME existing row - no duplicate FINAL result", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED");
    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;

    const first = await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    // A second call with a DIFFERENT minimumPracticalEffect but the SAME
    // calculation identity (same experimentId/versions/dataCutoffAt) must
    // still converge on the FIRST row - the persisted status is never
    // silently replaced by a differently-parameterized recomputation.
    const second = await persistExperimentResult(computed.result, null);

    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status !== "created" || second.status !== "existing") return;
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.resultStatus).toBe(first.record.resultStatus); // still VALID_EFFECT, not overwritten to VALID_INCONCLUSIVE

    const rows = await prisma.experimentMeasurementResult.findMany({ where: { experimentId: experiment.id } });
    expect(rows).toHaveLength(1); // no duplicate FINAL row for this identity
  }, 60_000);

  it("6. concurrent persistence calls for the identical calculation identity converge on exactly one row", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED");
    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;

    const outcomes = await Promise.all(Array.from({ length: 5 }, () => persistExperimentResult(computed.result, { minimumRateDifference: 0.05 })));
    const ids = new Set(outcomes.map((o) => (o.status === "rejected" ? null : o.record.id)));
    expect(ids.size).toBe(1); // every concurrent call converged on the same row
    expect(outcomes.filter((o) => o.status === "created")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "existing")).toHaveLength(4);

    const rows = await prisma.experimentMeasurementResult.findMany({ where: { experimentId: experiment.id } });
    expect(rows).toHaveLength(1);
  }, 60_000);

  it("8. INTERIM for a RUNNING experiment vs. FINAL for a COMPLETED, fully-matured one", async () => {
    const merchant = await makeMerchant();

    const runningExperiment = await makeCleanEffectExperiment(merchant, "RUNNING");
    const computedRunning = await computeExperimentResult(runningExperiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computedRunning.status).toBe("computed");
    if (computedRunning.status !== "computed") return;
    const runningOutcome = await persistExperimentResult(computedRunning.result, null);
    expect(runningOutcome.status).toBe("created");
    if (runningOutcome.status !== "created") return;
    expect(runningOutcome.record.resultKind).toBe("INTERIM");

    const completedExperiment = await makeCleanEffectExperiment(merchant, "COMPLETED");
    const computedCompleted = await computeExperimentResult(completedExperiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computedCompleted.status).toBe("computed");
    if (computedCompleted.status !== "computed") return;
    const completedOutcome = await persistExperimentResult(computedCompleted.result, null);
    expect(completedOutcome.status).toBe("created");
    if (completedOutcome.status !== "created") return;
    expect(completedOutcome.record.resultKind).toBe("FINAL");

    // Mark the RUNNING experiment COMPLETED immediately so it never lingers
    // as a globally-visible RUNNING row for other concurrently-running
    // integration test files/workers.
    await prisma.experiment.update({ where: { id: runningExperiment.id }, data: { status: "COMPLETED", endedAt: EXPERIMENT_ENDED_AT } });
  }, 90_000);

  it("10. a successful persistence creates exactly one paired AuditEvent", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED");
    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;

    const outcome = await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;

    const auditEvents = await prisma.auditEvent.findMany({ where: { entityType: "ExperimentMeasurementResult", entityId: outcome.record.id } });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({ action: "experiment_measurement_result.created", actorType: "SYSTEM" });
  }, 60_000);

  it("11. persistence (including a version-race retry) never alters any source-of-truth row", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED");
    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;

    const before = await sourceRowCounts(merchant.id, experiment.id);

    // Exercise the create path, the idempotent-duplicate path, AND the
    // concurrent version-race-retry path against the SAME source rows.
    await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    const later = new Date(NOW.getTime() + 60_000);
    const computedLater = await computeExperimentResult(experiment.id, 0.95, { now: later, minimumAnalyzableSamplePerArm: 1 });
    expect(computedLater.status).toBe("computed");
    if (computedLater.status !== "computed") return;
    await Promise.all(Array.from({ length: 3 }, () => persistExperimentResult(computedLater.result, null)));

    const after = await sourceRowCounts(merchant.id, experiment.id);
    expect(after).toEqual(before);
  }, 60_000);

  it("12. persisted GMV figures are exact integer paise, matching the underlying Outcome amounts precisely", async () => {
    const merchant = await makeMerchant();
    const experiment = await makeCleanEffectExperiment(merchant, "COMPLETED", 3); // 3 TREATMENT successes x 1000 paise
    const computed = await computeExperimentResult(experiment.id, 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });
    expect(computed.status).toBe("computed");
    if (computed.status !== "computed") return;

    const outcome = await persistExperimentResult(computed.result, { minimumRateDifference: 0.05 });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;

    expect(outcome.record.treatmentRecoveredGMVPaise).toBe(3000);
    expect(outcome.record.controlRecoveredGMVPaise).toBe(0);
    expect(Number.isInteger(outcome.record.treatmentRecoveredGMVPaise)).toBe(true);
    expect(Number.isInteger(outcome.record.controlRecoveredGMVPaise)).toBe(true);
    if (outcome.record.estimatedIncrementalGMVPaise !== null) {
      expect(Number.isInteger(outcome.record.estimatedIncrementalGMVPaise)).toBe(true);
    }
  }, 60_000);

  it("returns rejected(not_computed) for an experiment_not_found outcome, touching no tables", async () => {
    const outcome = await persistExperimentResult({ status: "experiment_not_found" }, null);
    expect(outcome).toEqual({ status: "rejected", reason: "not_computed" });
  });
});
