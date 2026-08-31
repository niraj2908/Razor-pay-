import { prisma } from "@/lib/db";
import { DEMO_IDENTITY, type DemoWorkspaceIdentity } from "./config";

/**
 * Deterministic Demo Workspace reset (Phase 28B).
 *
 * Deletes ONLY rows reachable from the ONE merchant named by the identity
 * it is given (`DEMO_IDENTITY` by default) - every query below is
 * explicitly scoped to that id, so this can never touch a different
 * Merchant's data, by construction, not merely by care.
 *
 * The identity is a parameter rather than a module constant because the
 * integration suite must be able to reset ITS OWN throwaway workspace
 * without touching the evaluator's. Local development, the integration
 * suite and the deployed application all share one database, so a suite
 * that reset the real demo left the deployment with an empty workspace and
 * a visitor seeing "demo workspace not seeded". Tests now pass their own
 * identity; only a deliberate operator action resets the real one.
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
  | { status: "refused"; reason: string }
  | {
      status: "reset";
      deletedAuditEvents: number;
      deletedPaymentEvents: number;
    };

/**
 * Defense in depth on top of the per-identity scoping above.
 *
 * Nothing in the running application calls this function - it is a CLI and
 * test entry point only - so if it is ever reached inside a deployed
 * serverless runtime, something is wrong and the safe answer is to refuse
 * rather than delete the workspace an evaluator is currently looking at.
 * `VERCEL` is set by the platform on every deployment build and invocation.
 *
 * Scoped deliberately to the real evaluator workspace: a throwaway test
 * identity is never what this is protecting, and refusing those would break
 * legitimate cleanup for no safety gain.
 */
function refuseDestructiveResetInDeployedRuntime(identity: DemoWorkspaceIdentity): string | null {
  if (identity.merchantId !== DEMO_IDENTITY.merchantId) return null;
  if (!process.env.VERCEL) return null;
  return "Refusing to reset the evaluator Demo Workspace from inside a deployed runtime.";
}

export async function resetDemoWorkspace(
  identity: DemoWorkspaceIdentity = DEMO_IDENTITY
): Promise<ResetDemoWorkspaceResult> {
  const refusal = refuseDestructiveResetInDeployedRuntime(identity);
  if (refusal) {
    return { status: "refused", reason: refusal };
  }

  const targetMerchantId = identity.merchantId;
  const merchant = await prisma.merchant.findUnique({ where: { id: targetMerchantId } });
  if (!merchant) {
    return { status: "not_found" };
  }

  const [payments, decisions, executions, outcomes, assignments, measurementResults] = await Promise.all([
    prisma.payment.findMany({ where: { merchantId: targetMerchantId }, select: { id: true } }),
    prisma.decision.findMany({ where: { revenueRiskEvent: { merchantId: targetMerchantId } }, select: { id: true } }),
    prisma.execution.findMany({ where: { decision: { revenueRiskEvent: { merchantId: targetMerchantId } } }, select: { id: true } }),
    prisma.outcome.findMany({ where: { decision: { revenueRiskEvent: { merchantId: targetMerchantId } } }, select: { id: true } }),
    prisma.experimentAssignment.findMany({ where: { experiment: { merchantId: targetMerchantId } }, select: { id: true } }),
    prisma.experimentMeasurementResult.findMany({ where: { experiment: { merchantId: targetMerchantId } }, select: { id: true } }),
  ]);

  const auditDeletion = await prisma.auditEvent.deleteMany({
    where: {
      OR: [
        { merchantId: targetMerchantId },
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
  await prisma.merchant.delete({ where: { id: targetMerchantId } });

  return {
    status: "reset",
    deletedAuditEvents: auditDeletion.count,
    deletedPaymentEvents: paymentEventDeletion.count,
  };
}
