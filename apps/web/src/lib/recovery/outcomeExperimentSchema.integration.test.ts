import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Schema/domain integration tests for the Phase 23 Step 2 Outcome +
 * Experiment foundation. These prove real Postgres constraint enforcement
 * (foreign keys, unique constraints) - a mocked Prisma client can only
 * prove our own code reacts correctly to a *simulated* error, not that the
 * database actually enforces the constraint. Run via `pnpm test:integration`,
 * never as part of the default `pnpm test`.
 *
 * Every row created here is a clearly-marked schema-validation fixture
 * (tagged with a random suffix), cleaned up in afterAll - not a fabricated
 * "business outcome." The 7 existing Test Mode webhook fixtures and all
 * existing migrations/decisions/executions are never touched.
 */

const TAG = `phase23-step2-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdExperimentIds: string[] = [];

async function makeCandidate() {
  const merchant = await prisma.merchant.create({ data: { name: `Schema test merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);

  const payment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: "FAILED" },
  });

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: merchant.id,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
    },
  });

  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", expectedIncrementalValue: 50 },
  });

  return { merchantId: merchant.id, paymentId: payment.id, riskEventId: riskEvent.id, decisionId: decision.id };
}

async function makeExecution(decisionId: string, paymentId: string) {
  return prisma.execution.create({
    data: { decisionId, paymentId, actionType: "PAYMENT_LINK", status: "SUCCEEDED" },
  });
}

afterAll(async () => {
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({
    where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } },
  });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.$disconnect();
});

describe("Outcome model", () => {
  it("1. creates a valid Outcome", async () => {
    const { decisionId, paymentId } = await makeCandidate();

    const outcome = await prisma.outcome.create({
      data: {
        decisionId,
        paymentId,
        status: "PENDING",
        attributionPolicyVersion: "attribution-v1",
      },
    });

    expect(outcome.decisionId).toBe(decisionId);
    expect(outcome.status).toBe("PENDING");
    expect(outcome.attributionStatus).toBeNull();
  });

  it("2. supports each AttributionStatus value", async () => {
    // Three sequential candidate chains against the real remote DB - longer
    // than the default 5s timeout under normal network latency.
    for (const attributionStatus of ["NATURAL_RECOVERY", "INTERVENTION_RECOVERY", "UNKNOWN"] as const) {
      const { decisionId, paymentId } = await makeCandidate();

      const outcome = await prisma.outcome.create({
        data: {
          decisionId,
          paymentId,
          status: "RECOVERED",
          attributionStatus,
          recoveredAmount: 10000,
          attributionPolicyVersion: "attribution-v1",
        },
      });

      expect(outcome.attributionStatus).toBe(attributionStatus);
    }
  }, 20_000);

  it("7. an Outcome resolves its Decision relation", async () => {
    const { decisionId, paymentId } = await makeCandidate();
    await prisma.outcome.create({
      data: { decisionId, paymentId, status: "PENDING", attributionPolicyVersion: "attribution-v1" },
    });

    const outcome = await prisma.outcome.findUniqueOrThrow({
      where: { decisionId },
      include: { decision: true },
    });

    expect(outcome.decision.id).toBe(decisionId);
  });

  it("8. an Outcome resolves its Execution relation where applicable, and allows null where not", async () => {
    const withExecution = await makeCandidate();
    const execution = await makeExecution(withExecution.decisionId, withExecution.paymentId);
    const outcomeWithExecution = await prisma.outcome.create({
      data: {
        decisionId: withExecution.decisionId,
        paymentId: withExecution.paymentId,
        executionId: execution.id,
        status: "RECOVERED",
        attributionStatus: "INTERVENTION_RECOVERY",
        recoveredAmount: 10000,
        attributionPolicyVersion: "attribution-v1",
      },
      include: { execution: true },
    });
    expect(outcomeWithExecution.execution?.id).toBe(execution.id);

    // Natural recovery: no intervention was ever executed for this decision.
    const withoutExecution = await makeCandidate();
    const outcomeWithoutExecution = await prisma.outcome.create({
      data: {
        decisionId: withoutExecution.decisionId,
        paymentId: withoutExecution.paymentId,
        status: "RECOVERED",
        attributionStatus: "NATURAL_RECOVERY",
        recoveredAmount: 10000,
        attributionPolicyVersion: "attribution-v1",
      },
    });
    expect(outcomeWithoutExecution.executionId).toBeNull();
  }, 20_000);

  it("9. rejects an Outcome referencing a Decision that does not exist", async () => {
    const { paymentId } = await makeCandidate();

    await expect(
      prisma.outcome.create({
        data: {
          decisionId: "decision_does_not_exist",
          paymentId,
          status: "PENDING",
          attributionPolicyVersion: "attribution-v1",
        },
      })
    ).rejects.toMatchObject({ code: "P2003" }); // real Postgres FK violation
  });

  it("10. recoveredAmount follows the existing integer-paise convention", async () => {
    const { decisionId, paymentId } = await makeCandidate();

    const outcome = await prisma.outcome.create({
      data: {
        decisionId,
        paymentId,
        status: "RECOVERED",
        attributionStatus: "INTERVENTION_RECOVERY",
        recoveredAmount: 123456, // paise - an arbitrary but exact integer
        attributionPolicyVersion: "attribution-v1",
      },
    });

    expect(outcome.recoveredAmount).toBe(123456);
    expect(Number.isInteger(outcome.recoveredAmount)).toBe(true);
  });
});

describe("Experiment model", () => {
  it("3. creates a valid Experiment with correct defaults", async () => {
    const experiment = await prisma.experiment.create({
      data: {
        name: `Schema test experiment ${TAG}`,
        version: "v1",
        hypothesis: "Sending a Payment Link within 1 hour increases recovery.",
        treatmentDefinition: "policy-v1",
      },
    });
    createdExperimentIds.push(experiment.id);

    expect(experiment.status).toBe("DRAFT");
    expect(experiment.controlDefinition).toBe("no_intervention");
    expect(experiment.trafficAllocationPercent).toBe(100);
    expect(experiment.startedAt).toBeNull();
  });
});

describe("ExperimentAssignment model", () => {
  it("4. creates a valid CONTROL assignment", async () => {
    const experiment = await prisma.experiment.create({
      data: { name: `Schema test experiment ${TAG}`, version: "v1", treatmentDefinition: "policy-v1" },
    });
    createdExperimentIds.push(experiment.id);
    const { riskEventId } = await makeCandidate();

    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CANDIDATE",
        unitKey: riskEventId,
        arm: "CONTROL",
        eligibilityVersion: "eligibility-v1",
      },
    });

    expect(assignment.arm).toBe("CONTROL");
  });

  it("5. creates a valid TREATMENT assignment", async () => {
    const experiment = await prisma.experiment.create({
      data: { name: `Schema test experiment ${TAG}`, version: "v1", treatmentDefinition: "policy-v1" },
    });
    createdExperimentIds.push(experiment.id);
    const { riskEventId } = await makeCandidate();

    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CANDIDATE",
        unitKey: riskEventId,
        arm: "TREATMENT",
        eligibilityVersion: "eligibility-v1",
      },
    });

    expect(assignment.arm).toBe("TREATMENT");
  });

  it("6. rejects a duplicate assignment for the same experiment+unit (real DB unique constraint, not check-then-insert)", async () => {
    const experiment = await prisma.experiment.create({
      data: { name: `Schema test experiment ${TAG}`, version: "v1", treatmentDefinition: "policy-v1" },
    });
    createdExperimentIds.push(experiment.id);
    const { riskEventId } = await makeCandidate();

    await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CANDIDATE",
        unitKey: riskEventId,
        arm: "TREATMENT",
        eligibilityVersion: "eligibility-v1",
      },
    });

    await expect(
      prisma.experimentAssignment.create({
        data: {
          experimentId: experiment.id,
          unitType: "CANDIDATE",
          unitKey: riskEventId,
          arm: "CONTROL", // even a different arm must not be allowed to double-assign
          eligibilityVersion: "eligibility-v1",
        },
      })
    ).rejects.toMatchObject({ code: "P2002" }); // real Postgres unique violation
  });

  it("a CUSTOMER-unit assignment can be reused across multiple recovery candidates", async () => {
    const experiment = await prisma.experiment.create({
      data: { name: `Schema test experiment ${TAG}`, version: "v1", treatmentDefinition: "policy-v1" },
    });
    createdExperimentIds.push(experiment.id);

    const merchant = await prisma.merchant.create({ data: { name: `Schema test merchant ${TAG}` } });
    createdMerchantIds.push(merchant.id);
    const customer = await prisma.customer.create({
      data: { merchantId: merchant.id, razorpayCustomerId: `cust_${TAG}` },
    });

    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CUSTOMER",
        unitKey: customer.id,
        arm: "TREATMENT",
        eligibilityVersion: "eligibility-v1",
      },
    });

    const payment1 = await prisma.payment.create({
      data: { merchantId: merchant.id, customerId: customer.id, amount: 5000, currency: "INR", status: "FAILED" },
    });
    const payment2 = await prisma.payment.create({
      data: { merchantId: merchant.id, customerId: customer.id, amount: 7000, currency: "INR", status: "FAILED" },
    });

    const riskEvent1 = await prisma.revenueRiskEvent.create({
      data: {
        merchantId: merchant.id,
        paymentId: payment1.id,
        diagnosis: "CUSTOMER_ABANDONMENT",
        amountAtRisk: 5000,
        dataSource: "SIMULATED",
        experimentAssignmentId: assignment.id,
      },
    });
    const riskEvent2 = await prisma.revenueRiskEvent.create({
      data: {
        merchantId: merchant.id,
        paymentId: payment2.id,
        diagnosis: "CUSTOMER_ABANDONMENT",
        amountAtRisk: 7000,
        dataSource: "SIMULATED",
        experimentAssignmentId: assignment.id,
      },
    });

    const reloaded = await prisma.experimentAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
      include: { revenueRiskEvents: true },
    });
    expect(reloaded.revenueRiskEvents.map((r) => r.id).sort()).toEqual([riskEvent1.id, riskEvent2.id].sort());
  }, 20_000);
});
