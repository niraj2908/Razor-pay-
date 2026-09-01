import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";

/**
 * Real-database integration tests for the operator-triggered execution
 * boundary. The merchant-isolation guarantee here is a WHERE clause across
 * a two-hop relation (Decision -> RevenueRiskEvent -> merchantId), which a
 * mocked Prisma client cannot prove - only a real database can show the
 * foreign-merchant decision genuinely does not match.
 *
 * RazorpayClient is mocked: this file's subject is the service's own
 * decision-loading, refusal and hand-off behaviour, and a real Test Mode
 * Payment Link is already proven separately by
 * executionService.integration.test.ts. Creating more real links here would
 * consume the account's quota to re-prove someone else's assertion.
 */

const paymentLinksCreate = vi.fn();
vi.mock("@/lib/razorpay/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay/client")>("@/lib/razorpay/client");
  return {
    ...actual,
    RazorpayClient: { ...actual.RazorpayClient, paymentLinks: { create: paymentLinksCreate } },
  };
});

const { executeDecision } = await import("./decisionExecutionService");

const TAG = `execute-decision-${randomUUID()}`;
const createdMerchantIds: string[] = [];

async function makeDecision(options: {
  decisionType: "ACT" | "WAIT";
  withChosenAction?: boolean;
  amountPaise?: number;
}) {
  const merchant = await prisma.merchant.create({ data: { name: `Execute test merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);

  const amount = options.amountPaise ?? 250_000;
  const payment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount, currency: "INR", status: "FAILED", method: "card" },
  });

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: merchant.id,
      paymentId: payment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: amount,
      dataSource: "SIMULATED",
    },
  });

  const chosenAction = options.withChosenAction
    ? await prisma.candidateAction.create({
        data: {
          revenueRiskEventId: riskEvent.id,
          actionType: "PAYMENT_LINK",
          predictedSuccessProbability: 0.7,
          incrementalLift: 0.45,
          estimatedCost: 0,
          expectedNetValue: 112_300,
        },
      })
    : null;

  const decision = await prisma.decision.create({
    data: {
      revenueRiskEventId: riskEvent.id,
      decisionType: options.decisionType,
      chosenActionId: chosenAction?.id ?? null,
      expectedIncrementalValue: 112_300,
    },
  });

  return { merchantId: merchant.id, decisionId: decision.id, paymentId: payment.id };
}

afterEach(() => {
  paymentLinksCreate.mockReset();
});

afterAll(async () => {
  // Scoped to this file's own executions, resolved before they are deleted.
  const executionIds = await prisma.execution
    .findMany({ where: { payment: { merchantId: { in: createdMerchantIds } } }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id));
  await prisma.auditEvent.deleteMany({ where: { entityType: "Execution", entityId: { in: executionIds } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.candidateAction.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("executeDecision against a real database", () => {
  it(
    "CRITICAL: another merchant's ACT decision is not found, and no Razorpay call is made",
    async () => {
      const own = await makeDecision({ decisionType: "ACT", withChosenAction: true });
      const foreign = await makeDecision({ decisionType: "ACT", withChosenAction: true });

      const result = await executeDecision(own.merchantId, foreign.decisionId);

      expect(result).toEqual({ status: "not_found" });
      expect(paymentLinksCreate).not.toHaveBeenCalled();
      const executions = await prisma.execution.count({ where: { decisionId: foreign.decisionId } });
      expect(executions).toBe(0);
    },
    30_000
  );

  it(
    "refuses a non-ACT decision without calling Razorpay",
    async () => {
      const { merchantId, decisionId } = await makeDecision({ decisionType: "WAIT", withChosenAction: true });

      const result = await executeDecision(merchantId, decisionId);

      expect(result).toEqual({ status: "refused", reason: "decision_not_act" });
      expect(paymentLinksCreate).not.toHaveBeenCalled();
    },
    30_000
  );

  it(
    "refuses an ACT decision that has no chosen action",
    async () => {
      const { merchantId, decisionId } = await makeDecision({ decisionType: "ACT", withChosenAction: false });

      const result = await executeDecision(merchantId, decisionId);

      expect(result).toEqual({ status: "refused", reason: "no_chosen_action" });
      expect(paymentLinksCreate).not.toHaveBeenCalled();
    },
    30_000
  );

  it(
    "executes an ACT decision through the Execution Service, recording the execution and its audit trail",
    async () => {
      paymentLinksCreate.mockResolvedValue({ id: "plink_integration", shortUrl: "https://rzp.io/i/x", status: "created" });
      const { merchantId, decisionId, paymentId } = await makeDecision({
        decisionType: "ACT",
        withChosenAction: true,
      });

      const result = await executeDecision(merchantId, decisionId);

      expect(result.status).toBe("executed");
      if (result.status !== "executed") return;
      expect(result.result.status).toBe("succeeded");

      const execution = await prisma.execution.findUniqueOrThrow({ where: { decisionId } });
      expect(execution.paymentId).toBe(paymentId);
      expect(execution.actionType).toBe("PAYMENT_LINK");
      expect(execution.status).toBe("SUCCEEDED");
      expect(execution.razorpayReferenceId).toBe("plink_integration");

      const actions = await prisma.auditEvent
        .findMany({ where: { entityType: "Execution", entityId: execution.id } })
        .then((rows) => rows.map((row) => row.action));
      expect(actions).toContain("execution.requested");
      expect(actions).toContain("execution.succeeded");
    },
    30_000
  );

  it(
    "a second trigger on the same decision never makes a second Razorpay call",
    async () => {
      paymentLinksCreate.mockResolvedValue({ id: "plink_once", shortUrl: "https://rzp.io/i/y", status: "created" });
      const { merchantId, decisionId } = await makeDecision({ decisionType: "ACT", withChosenAction: true });

      const first = await executeDecision(merchantId, decisionId);
      const second = await executeDecision(merchantId, decisionId);

      expect(first.status).toBe("executed");
      expect(second.status).toBe("executed");
      if (second.status !== "executed") return;
      expect(second.result.status).toBe("existing");
      expect(paymentLinksCreate).toHaveBeenCalledTimes(1);

      const executions = await prisma.execution.count({ where: { decisionId } });
      expect(executions).toBe(1);
    },
    30_000
  );
});
