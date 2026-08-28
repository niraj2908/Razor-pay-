import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getDecisionAuditTrail } from "./decisionAuditService";

/**
 * Real-database integration tests for the Phase 25 Audit API V1's
 * merchant-isolation claim and entity-scope exclusion. A mocked Prisma
 * client can only prove our own code reacts correctly to a *simulated*
 * WHERE clause - it cannot prove that, with two real distinct Merchants and
 * real AuditEvent rows of every entityType present in the database, the
 * query still returns only the correct trail.
 *
 * AuditEvent rows are created directly via `prisma.auditEvent.create()`
 * with realistic details shapes, rather than by running the real Decision
 * Engine/Execution Service/Outcome pipeline - this file tests the READ
 * API's isolation/sanitization/exclusion behavior against real persisted
 * rows, not the pipeline's own correctness (covered elsewhere).
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-audit-api-${randomUUID()}`;
const createdMerchantIds: string[] = [];
// AuditEvent has no FK relation to Decision/Execution/Outcome/PaymentEvent/
// ExperimentAssignment (entityId is a plain string, not a relation) - a
// Merchant-cascade delete never reaches any AuditEvent row, so every
// entityId ever used as an AuditEvent.entityId in this file must be tracked
// and deleted explicitly.
const auditEntityIdsToClean: string[] = [];

async function makeMerchant(label: string) {
  const merchant = await prisma.merchant.create({ data: { name: `${label} ${TAG}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeDecisionChain(merchantId: string, opts: { withExecution?: boolean; withOutcome?: boolean } = {}) {
  const payment = await prisma.payment.create({
    data: { merchantId, amount: 10000, currency: "INR", status: "FAILED" },
  });
  const riskEvent = await prisma.revenueRiskEvent.create({
    data: { merchantId, paymentId: payment.id, diagnosis: "CUSTOMER_ABANDONMENT", amountAtRisk: 10000, dataSource: "SIMULATED" },
  });
  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: opts.withExecution ? "ACT" : "WAIT", expectedIncrementalValue: 50 },
  });

  let execution = null;
  if (opts.withExecution) {
    execution = await prisma.execution.create({
      data: { decisionId: decision.id, paymentId: payment.id, actionType: "PAYMENT_LINK", status: "SUCCEEDED", razorpayReferenceId: `plink_${randomUUID().slice(0, 10)}` },
    });
  }

  let outcome = null;
  if (opts.withOutcome) {
    outcome = await prisma.outcome.create({
      data: { decisionId: decision.id, paymentId: payment.id, executionId: execution?.id, status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 10000, attributionPolicyVersion: "attribution-v1" },
    });
  }

  auditEntityIdsToClean.push(decision.id);
  if (execution) auditEntityIdsToClean.push(execution.id);
  if (outcome) auditEntityIdsToClean.push(outcome.id);

  return { merchantId, paymentId: payment.id, decisionId: decision.id, executionId: execution?.id ?? null, outcomeId: outcome?.id ?? null };
}

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { entityId: { in: auditEntityIdsToClean } } });
  await prisma.outcome.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("Phase 25 Audit API V1 against a real database", () => {
  describe("merchant isolation", () => {
    it("Merchant A requesting Merchant B's real decisionId gets not_found, never the trail", async () => {
      const merchantA = await makeMerchant("Isolation merchant A");
      const merchantB = await makeMerchant("Isolation merchant B");
      const chainB = await makeDecisionChain(merchantB.id);
      await prisma.auditEvent.create({
        data: { merchantId: merchantB.id, entityType: "Decision", entityId: chainB.decisionId, action: "decision.wait", actorType: "SYSTEM", details: { decisionId: chainB.decisionId, reason: "test" } },
      });

      const result = await getDecisionAuditTrail(merchantA.id, chainB.decisionId, {});
      expect(result).toEqual({ status: "not_found" });
    }, 20_000);

    it("a genuinely nonexistent decisionId produces the identical not_found shape as a real foreign-merchant one", async () => {
      const merchantA = await makeMerchant("Enumeration-resistance merchant A");
      const merchantB = await makeMerchant("Enumeration-resistance merchant B");
      const chainB = await makeDecisionChain(merchantB.id);

      const foreignResult = await getDecisionAuditTrail(merchantA.id, chainB.decisionId, {});
      const nonexistentResult = await getDecisionAuditTrail(merchantA.id, `${chainB.decisionId}-does-not-exist`, {});
      expect(foreignResult).toEqual({ status: "not_found" });
      expect(nonexistentResult).toEqual({ status: "not_found" });
    }, 20_000);
  });

  describe("full ACT -> Execution -> Outcome chronological trail", () => {
    it("returns all three entity types in chronological order, each sanitized", async () => {
      const merchant = await makeMerchant("Full trail merchant");
      const chain = await makeDecisionChain(merchant.id, { withExecution: true, withOutcome: true });

      await prisma.auditEvent.create({
        data: { merchantId: merchant.id, entityType: "Decision", entityId: chain.decisionId, action: "decision.act", actorType: "SYSTEM", details: { decisionId: chain.decisionId, paymentId: chain.paymentId, selectedAction: "ACT", selectedStrategy: "PAYMENT_LINK", policyVersion: "policy-v1", modelVersion: "baseline-v1", reason: "positive_expected_incremental_value" } },
      });
      await prisma.auditEvent.create({
        data: { entityType: "Execution", entityId: chain.executionId!, action: "execution.succeeded", actorType: "SYSTEM", details: { decisionId: chain.decisionId, razorpayReferenceId: "plink_real_looking_id" } },
      });
      await prisma.auditEvent.create({
        data: { entityType: "Outcome", entityId: chain.outcomeId!, action: "outcome.created", actorType: "SYSTEM", details: { decisionId: chain.decisionId, outcomeStatus: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", reason: "captured_within_window", attributionPolicyVersion: "attribution-v1" } },
      });

      const result = await getDecisionAuditTrail(merchant.id, chain.decisionId, {});
      expect(result.status).toBe("found");
      if (result.status !== "found") throw new Error("expected found");
      expect(result.items.map((i) => i.entityType)).toEqual(["Decision", "Execution", "Outcome"]);
      expect(result.items[0].details.selectedAction).toBe("ACT");
      expect(result.items[1].details.razorpayReferenceId).toBe("plink_real_looking_id");
      expect(result.items[2].details.outcomeStatus).toBe("RECOVERED");
    }, 20_000);
  });

  describe("WAIT/STOP/ESCALATE with no downstream records", () => {
    it("returns only the Decision event - no Execution/Outcome rows exist to fabricate", async () => {
      const merchant = await makeMerchant("No-downstream merchant");
      const chain = await makeDecisionChain(merchant.id); // no execution, no outcome

      await prisma.auditEvent.create({
        data: { merchantId: merchant.id, entityType: "Decision", entityId: chain.decisionId, action: "decision.wait", actorType: "SYSTEM", details: { decisionId: chain.decisionId, reason: "cooldown_active" } },
      });

      const result = await getDecisionAuditTrail(merchant.id, chain.decisionId, {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].entityType).toBe("Decision");
      }
    }, 20_000);
  });

  describe("entity-type exclusion - PaymentEvent and ExperimentAssignment can never appear", () => {
    it("a PaymentEvent-entityType AuditEvent row sharing the SAME entityId as the real Decision never appears in the trail", async () => {
      const merchant = await makeMerchant("Exclusion merchant");
      const chain = await makeDecisionChain(merchant.id);

      await prisma.auditEvent.create({
        data: { merchantId: merchant.id, entityType: "Decision", entityId: chain.decisionId, action: "decision.wait", actorType: "SYSTEM", details: { decisionId: chain.decisionId, reason: "x" } },
      });
      // Deliberately the SAME entityId as the real Decision - proves
      // exclusion is by entityType, not merely by entityId happening to differ.
      await prisma.auditEvent.create({
        data: { entityType: "PaymentEvent", entityId: chain.decisionId, action: "payment_event.unassociated", actorType: "SYSTEM", details: { reason: "unsupported_event_type_for_association" } },
      });
      await prisma.auditEvent.create({
        data: { entityType: "ExperimentAssignment", entityId: chain.decisionId, action: "experiment_assignment.created", actorType: "SYSTEM", details: { unitKey: "clcustomer_real_id_leak_check" } },
      });

      const result = await getDecisionAuditTrail(merchant.id, chain.decisionId, {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items).toHaveLength(1);
        expect(result.items[0].entityType).toBe("Decision");
        expect(JSON.stringify(result.items)).not.toContain("clcustomer_real_id_leak_check");
        expect(JSON.stringify(result.items)).not.toContain("payment_event.unassociated");
      }
    }, 20_000);
  });

  describe("pagination boundaries", () => {
    it("paginates the trail via cursor - two pages cover all rows exactly once", async () => {
      // Longer timeout: this test alone makes ~9 sequential real-Postgres
      // round trips (merchant/payment/riskEvent/decision/execution creates,
      // 3 auditEvent creates, 2 paginated reads) - the default 5000ms is
      // borderline under real pooler latency, matching every other
      // integration test in this codebase that does comparable setup.
      const merchant = await makeMerchant("Pagination merchant");
      const chain = await makeDecisionChain(merchant.id, { withExecution: true });

      const created = [];
      created.push(
        await prisma.auditEvent.create({
          data: { merchantId: merchant.id, entityType: "Decision", entityId: chain.decisionId, action: "decision.act", actorType: "SYSTEM", details: { decisionId: chain.decisionId, reason: "x" } },
        })
      );
      for (let i = 0; i < 2; i++) {
        created.push(
          await prisma.auditEvent.create({
            data: { entityType: "Execution", entityId: chain.executionId!, action: `execution.step_${i}`, actorType: "SYSTEM", details: { decisionId: chain.decisionId, reason: `step_${i}` } },
          })
        );
      }

      const page1 = await getDecisionAuditTrail(merchant.id, chain.decisionId, { limit: 2 });
      expect(page1.status).toBe("found");
      if (page1.status !== "found") throw new Error("expected found");
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await getDecisionAuditTrail(merchant.id, chain.decisionId, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.status).toBe("found");
      if (page2.status !== "found") throw new Error("expected found");
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items].map((i) => i.id).sort();
      expect(allIds).toEqual(created.map((c) => c.id).sort());
    }, 20_000);
  });
});
