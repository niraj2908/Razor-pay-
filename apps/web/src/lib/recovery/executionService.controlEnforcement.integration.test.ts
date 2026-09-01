import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Real-database integration tests for Phase 23 Step 5's defense-in-depth
 * CONTROL enforcement inside the Execution Service (isControlArmForbidden
 * in executionService.ts). Uses REAL Postgres for the Decision ->
 * RevenueRiskEvent -> ExperimentAssignment resolution - a mocked Prisma
 * client can only prove our own code reacts correctly to a *simulated*
 * relation, not that the real FK chain resolves the way we assume.
 *
 * RazorpayClient is mocked here (unlike executionService.integration.test.ts,
 * which deliberately hits real Razorpay Test Mode) - this file's job is to
 * prove CONTROL never reaches Razorpay at all, so no real Test Mode call
 * should ever be needed to prove that; a TREATMENT/no-assignment success
 * path is proven via the mock being called, not via a live network request.
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`. Every row
 * is a clearly-marked fixture, cleaned up in afterAll/afterEach.
 */

const paymentLinksCreate = vi.fn();
vi.mock("@/lib/razorpay/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay/client")>("@/lib/razorpay/client");
  return {
    ...actual,
    RazorpayClient: {
      ...actual.RazorpayClient,
      paymentLinks: { create: paymentLinksCreate },
    },
  };
});

const { executeCommand } = await import("./executionService");

const TAG = `phase23-step5-hardening-${randomUUID()}`;
const createdExperimentIds: string[] = [];
const createdMerchantIds: string[] = [];

async function makeCandidate(arm: "CONTROL" | "TREATMENT" | null) {
  const merchant = await prisma.merchant.create({ data: { name: `Control enforcement merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);

  const payment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: "FAILED" },
  });

  let experimentAssignmentId: string | null = null;
  if (arm) {
    const experiment = await prisma.experiment.create({
      data: {
        merchantId: merchant.id,
        name: `Control enforcement experiment ${TAG}`,
        version: "v1",
        treatmentDefinition: "policy-v1",
        treatmentAllocationPercent: 50,
      },
    });
    createdExperimentIds.push(experiment.id);
    const assignment = await prisma.experimentAssignment.create({
      data: {
        experimentId: experiment.id,
        unitType: "CANDIDATE",
        unitKey: `${TAG}-${randomUUID()}`,
        arm,
        eligibilityVersion: "eligibility-v1",
        assignmentAlgorithm: "sha256-v1",
      },
    });
    experimentAssignmentId = assignment.id;
  }

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: merchant.id,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
      experimentAssignmentId,
    },
  });

  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", expectedIncrementalValue: 50 },
  });

  return { merchantId: merchant.id, paymentId: payment.id, decisionId: decision.id };
}

afterEach(() => {
  paymentLinksCreate.mockReset();
});

afterAll(async () => {
  // Scoped to THIS file's own executions, resolved before they are deleted.
  // A blanket delete on `entityType: "Execution"` would take out every
  // Execution audit row in the shared database - including the demo
  // workspace's and any other suite's, mid-run.
  const executionIds = await prisma.execution
    .findMany({ where: { payment: { merchantId: { in: createdMerchantIds } } }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id));
  await prisma.auditEvent.deleteMany({ where: { entityType: "Execution", entityId: { in: executionIds } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.$disconnect();
});

function commandFor(candidate: { decisionId: string; paymentId: string }) {
  return {
    decisionId: candidate.decisionId,
    paymentId: candidate.paymentId,
    action: "ACT" as const,
    strategy: "PAYMENT_LINK" as const,
    policyVersion: "policy-v1",
    decidedAt: new Date().toISOString(),
    amount: 10000,
  };
}

describe("executeCommand CONTROL enforcement against a real database", () => {
  it("1/2/3. a real CONTROL-assigned decision is rejected with zero Execution rows and zero Razorpay calls", async () => {
    const candidate = await makeCandidate("CONTROL");

    const result = await executeCommand(commandFor(candidate));

    expect(result).toEqual({ status: "rejected", reason: "control_arm_forbidden" });
    expect(paymentLinksCreate).not.toHaveBeenCalled();

    const executions = await prisma.execution.findMany({ where: { decisionId: candidate.decisionId } });
    expect(executions).toHaveLength(0);
  }, 20_000);

  it("4. a real TREATMENT-assigned decision proceeds through normal execution", async () => {
    const candidate = await makeCandidate("TREATMENT");
    paymentLinksCreate.mockResolvedValue({ id: "plink_treatment_real", shortUrl: "https://rzp.io/i/t", status: "created" });

    const result = await executeCommand(commandFor(candidate));

    expect(result).toMatchObject({ status: "succeeded", razorpayReferenceId: "plink_treatment_real" });
    expect(paymentLinksCreate).toHaveBeenCalledTimes(1);

    const execution = await prisma.execution.findUniqueOrThrow({ where: { decisionId: candidate.decisionId } });
    expect(execution.status).toBe("SUCCEEDED");
  }, 20_000);

  it("5. a real decision with NO ExperimentAssignment at all proceeds through normal execution unchanged", async () => {
    const candidate = await makeCandidate(null);
    paymentLinksCreate.mockResolvedValue({ id: "plink_none_real", shortUrl: "https://rzp.io/i/n", status: "created" });

    const result = await executeCommand(commandFor(candidate));

    expect(result).toMatchObject({ status: "succeeded", razorpayReferenceId: "plink_none_real" });
    expect(paymentLinksCreate).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("7. five concurrent execution attempts against a real CONTROL-assigned decision all reject - zero Execution rows created", async () => {
    const candidate = await makeCandidate("CONTROL");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => executeCommand(commandFor(candidate)))
    );

    expect(results.every((r) => r.status === "rejected" && r.reason === "control_arm_forbidden")).toBe(true);
    expect(paymentLinksCreate).not.toHaveBeenCalled();

    const executions = await prisma.execution.findMany({ where: { decisionId: candidate.decisionId } });
    expect(executions).toHaveLength(0);
  }, 20_000);

  it("8. existing Execution idempotency remains intact for a real TREATMENT-assigned decision (concurrent -> exactly one Execution)", async () => {
    const candidate = await makeCandidate("TREATMENT");
    paymentLinksCreate.mockResolvedValue({ id: "plink_race_real", shortUrl: "https://rzp.io/i/race", status: "created" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => executeCommand(commandFor(candidate)))
    );

    expect(paymentLinksCreate).toHaveBeenCalledTimes(1);
    const succeededOrExisting = results.filter((r) => r.status === "succeeded" || r.status === "existing");
    expect(succeededOrExisting).toHaveLength(5);

    const executions = await prisma.execution.findMany({ where: { decisionId: candidate.decisionId } });
    expect(executions).toHaveLength(1);
  }, 20_000);
});
