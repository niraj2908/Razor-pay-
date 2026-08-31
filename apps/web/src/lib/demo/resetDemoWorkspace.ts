import { prisma } from "@/lib/db";
import { DEMO_MERCHANT_ID } from "./config";

/**
 * Deterministic Demo Workspace reset (Phase 28B).
 *
 * Deletes ONLY rows reachable from the one fixed `DEMO_MERCHANT_ID` -
 * every query below is explicitly scoped to it, so this can never touch a
 * different Merchant's data, by construction, not merely by care.
 *
 * `AuditEvent` and `PaymentEvent` need EXPLICIT cleanup before the Merchant
 * itself is deleted: their relations to Merchant/Payment are `onDelete:
 * SetNull` in the schema (not `Cascade`), which is the correct real-world
 * behavior (an audit/webhook-log row should usually outlive the entity it
 * describes) - but it means a plain `merchant.delete()` alone would leave
 * these rows behind with a nulled-out foreign key instead of removing them,
 * which would fail the "verify zero Demo Workspace records remain" proof
 * this reset must satisfy. Every other table cascades correctly from
 * Merchant via `onDelete: Cascade` already declared in the schema.
 */
export type ResetDemoWorkspaceResult =
  | { status: "not_found" }
  | {
      status: "reset";
      deletedAuditEvents: number;
      deletedPaymentEvents: number;
    };

export async function resetDemoWorkspace(): Promise<ResetDemoWorkspaceResult> {
  const merchant = await prisma.merchant.findUnique({ where: { id: DEMO_MERCHANT_ID } });
  if (!merchant) {
    return { status: "not_found" };
  }

  const [payments, decisions, executions, outcomes, assignments, measurementResults] = await Promise.all([
    prisma.payment.findMany({ where: { merchantId: DEMO_MERCHANT_ID }, select: { id: true } }),
    prisma.decision.findMany({ where: { revenueRiskEvent: { merchantId: DEMO_MERCHANT_ID } }, select: { id: true } }),
    prisma.execution.findMany({ where: { decision: { revenueRiskEvent: { merchantId: DEMO_MERCHANT_ID } } }, select: { id: true } }),
    prisma.outcome.findMany({ where: { decision: { revenueRiskEvent: { merchantId: DEMO_MERCHANT_ID } } }, select: { id: true } }),
    prisma.experimentAssignment.findMany({ where: { experiment: { merchantId: DEMO_MERCHANT_ID } }, select: { id: true } }),
    prisma.experimentMeasurementResult.findMany({ where: { experiment: { merchantId: DEMO_MERCHANT_ID } }, select: { id: true } }),
  ]);

  const auditDeletion = await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { merchantId: DEMO_MERCHANT_ID },
        { entityType: "Decision", entityId: { in: decisions.map((d) => d.id) } },
        { entityType: "Execution", entityId: { in: executions.map((e) => e.id) } },
        { entityType: "Outcome", entityId: { in: outcomes.map((o) => o.id) } },
        { entityType: "ExperimentAssignment", entityId: { in: assignments.map((a) => a.id) } },
        { entityType: "ExperimentMeasurementResult", entityId: { in: measurementResults.map((r) => r.id) } },
      ],
    },
  });

  const paymentEventDeletion = await prisma.paymentEvent.deleteMany({
    where: { paymentId: { in: payments.map((p) => p.id) } },
  });

  // Cascades: Customer, Order, Payment, RevenueRiskEvent (-> ModelPrediction,
  // CandidateAction, Decision -> DecisionEvidence/Execution/Outcome),
  // MerchantPolicy, Operator -> OperatorSession, Experiment ->
  // ExperimentAssignment/ExperimentResult/ExperimentMeasurementResult.
  await prisma.merchant.delete({ where: { id: DEMO_MERCHANT_ID } });

  return {
    status: "reset",
    deletedAuditEvents: auditDeletion.count,
    deletedPaymentEvents: paymentEventDeletion.count,
  };
}
