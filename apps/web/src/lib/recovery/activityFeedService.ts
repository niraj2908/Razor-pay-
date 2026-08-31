import { prisma } from "@/lib/db";
import { mapAuditEvent, type AuditEventDTO } from "./decisionAuditService";

/**
 * Merchant-wide recent activity feed (Phase 28C Overview/Reports addition).
 *
 * `decisionAuditService.ts`'s `getDecisionAuditTrail` is scoped to ONE
 * decision; this is the same trust contract and the same sanitization
 * (`mapAuditEvent`, reused unchanged) generalized to "the merchant's most
 * recent activity across all of its decisions." Merchant isolation works
 * identically: AuditEvent.merchantId is unreliable (null for Execution/
 * Outcome rows - see decisionAuditService.ts's own doc comment), so this
 * NEVER queries AuditEvent.merchantId. It first proves which Decision/
 * Execution/Outcome ids belong to this merchant via the real
 * `revenueRiskEvent: { merchantId }` relation, then queries AuditEvent only
 * by those already-verified ids - the exact same two-step shape
 * decisionAuditService.ts already uses and has already proven safe.
 *
 * Bounded by `decisionWindow` (which recent decisions to search within)
 * before ever touching AuditEvent, so this stays a small, cheap query at
 * any real scale rather than scanning every decision a merchant has ever
 * had.
 */
export async function getRecentActivity(merchantId: string, limit = 10, decisionWindow = 50): Promise<AuditEventDTO[]> {
  const recentDecisions = await prisma.decision.findMany({
    where: { revenueRiskEvent: { merchantId } },
    orderBy: { decidedAt: "desc" },
    take: decisionWindow,
    select: {
      id: true,
      executions: { select: { id: true } },
      outcome: { select: { id: true } },
    },
  });

  const decisionIds = recentDecisions.map((d) => d.id);
  const executionIds = recentDecisions.flatMap((d) => d.executions.map((e) => e.id));
  const outcomeIds = recentDecisions.map((d) => d.outcome?.id).filter((id): id is string => Boolean(id));

  if (decisionIds.length === 0) {
    return [];
  }

  const rows = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { entityType: "Decision", entityId: { in: decisionIds } },
        ...(executionIds.length > 0 ? [{ entityType: "Execution" as const, entityId: { in: executionIds } }] : []),
        ...(outcomeIds.length > 0 ? [{ entityType: "Outcome" as const, entityId: { in: outcomeIds } }] : []),
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });

  return rows
    .filter((row) => row.entityType === "Decision" || row.entityType === "Execution" || row.entityType === "Outcome")
    .map((row) => mapAuditEvent(row as Parameters<typeof mapAuditEvent>[0]));
}
