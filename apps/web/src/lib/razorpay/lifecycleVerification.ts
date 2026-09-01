import { prisma } from "@/lib/db";

/**
 * Whether a REAL Razorpay Test Mode payment has actually travelled the
 * recovery lifecycle on this deployment - derived from the database, never
 * asserted.
 *
 * The Security page previously carried this as prose, which went stale the
 * moment a real payment did complete the chain: it still read "E2E
 * verification blocked - quota exhausted" while a genuine lifecycle sat in
 * the database. A hardcoded verification claim can only ever be right at the
 * moment it is written, and a stale one is worse than none - so this reads
 * the evidence instead.
 *
 * Scoped to `RevenueRiskEvent.dataSource = REAL_RAZORPAY_TEST_MODE`, which
 * is set only by the real webhook ingestion path. Synthetic Demo rows are
 * SIMULATED and can never satisfy any of these checks, so seeding the demo
 * can never make this page claim a real lifecycle.
 */
export type RazorpayLifecycleVerification = {
  /** A real payment reached the Decision Engine and a decision was recorded. */
  decisionObserved: boolean;
  /** A real decision led to a recovery execution being attempted. */
  executionObserved: boolean;
  /** A real decision reached outcome attribution. */
  outcomeObserved: boolean;
  /** Decision types the engine has actually produced from real payments. */
  decisionTypes: string[];
};

export async function resolveRazorpayLifecycleVerification(): Promise<RazorpayLifecycleVerification> {
  const configuredMerchantId = process.env.RAZORPAY_MERCHANT_ID?.trim();
  if (!configuredMerchantId) {
    return { decisionObserved: false, executionObserved: false, outcomeObserved: false, decisionTypes: [] };
  }

  const decisions = await prisma.decision.findMany({
    where: {
      revenueRiskEvent: { merchantId: configuredMerchantId, dataSource: "REAL_RAZORPAY_TEST_MODE" },
    },
    select: { decisionType: true, outcome: { select: { id: true } }, executions: { select: { id: true } } },
  });

  return {
    decisionObserved: decisions.length > 0,
    executionObserved: decisions.some((d) => d.executions.length > 0),
    outcomeObserved: decisions.some((d) => d.outcome !== null),
    decisionTypes: [...new Set(decisions.map((d) => d.decisionType))].sort(),
  };
}
