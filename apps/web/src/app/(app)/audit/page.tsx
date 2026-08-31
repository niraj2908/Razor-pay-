import Link from "next/link";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { getRecentActivity, isActivityEntityType } from "@/lib/recovery/activityFeedService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Timestamp } from "@/components/ui/Timestamp";
import { humanizeAuditAction, humanizeEnumValue } from "@/lib/design/text";
import { resolveAuditMarker } from "@/lib/design/auditMarker";
import { TONE_BORDER, TONE_BG, TONE_ICON } from "@/lib/design/tone";
import { AuditIcon } from "@/lib/design/icons";
import { AuditFilters } from "./AuditFilters";

const ACTIVITY_LIMIT = 50;
const REDUNDANT_DETAIL_KEYS = new Set(["decisionId", "paymentId"]);
const ENUM_SHAPE = /^[A-Za-z]+(_[A-Za-z]+)*$/;

/**
 * Merchant-wide Audit Trail (Phase 28C). The per-decision Audit Trail
 * (`recovery/[decisionId]/audit`) remains the authoritative, fully
 * paginated record for one decision; this page is its merchant-wide
 * counterpart - the most recent activity across every decision, reusing
 * the exact same `getRecentActivity` service and sanitized `AuditEventDTO`
 * shape Overview's own activity feed already uses.
 *
 * Bounded to the {ACTIVITY_LIMIT} most recent events rather than
 * cursor-paginated - an honest, stated limit (shown below the list) rather
 * than a silent truncation. A decision's own audit trail page still offers
 * full pagination for anyone who needs the complete history of one case.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entityType?: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const params = await searchParams;
  const entityType = isActivityEntityType(params.entityType) ? params.entityType : undefined;
  const events = await getRecentActivity(merchantId, ACTIVITY_LIMIT, 200, entityType ? [entityType] : undefined);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Audit trail"
        description="Chronological record of decisions, executions, and outcomes across your merchant."
        icon={AuditIcon}
        actions={<AuditFilters entityType={entityType ?? ""} />}
      />

      {events.length === 0 ? (
        <p className="text-fg-muted py-8 text-center text-sm italic">No audit events recorded yet.</p>
      ) : (
        <ol className="flex max-w-3xl flex-col gap-5">
          {events.map((event) => {
            const marker = resolveAuditMarker(event);
            const MarkerIcon = marker.icon;
            const decisionId = typeof event.details.decisionId === "string" ? event.details.decisionId : null;
            const entries = Object.entries(event.details).filter(([key]) => !REDUNDANT_DETAIL_KEYS.has(key));
            return (
              <li key={event.id} className="flex gap-3">
                <div className="flex flex-col items-center pt-0.5">
                  <span
                    aria-hidden="true"
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${TONE_BORDER[marker.tone]} ${TONE_BG[marker.tone]}`}
                  >
                    <MarkerIcon aria-hidden="true" className={`h-3.5 w-3.5 ${TONE_ICON[marker.tone]}`} />
                  </span>
                  <span className="bg-border mt-1 w-px flex-1" />
                </div>
                <div className="flex-1 pb-1">
                  <div className="flex items-baseline justify-between gap-2">
                    {decisionId ? (
                      <Link href={`/recovery/${decisionId}`} className="text-info text-sm font-medium hover:underline">
                        {humanizeAuditAction(event.action)}
                      </Link>
                    ) : (
                      <span className="text-fg text-sm font-medium">{humanizeAuditAction(event.action)}</span>
                    )}
                    <Timestamp iso={event.createdAt} className="text-fg-muted text-xs" />
                  </div>
                  <div className="text-fg-muted mt-0.5 text-xs">
                    {event.entityType} &middot; {humanizeEnumValue(event.actorType)}
                  </div>
                  {entries.length > 0 ? (
                    <dl className="mt-2 flex flex-col gap-1 text-sm">
                      {entries.map(([key, value]) => (
                        <div key={key} className="flex gap-2">
                          <dt className="text-fg-muted">{humanizeEnumValue(key.replace(/([A-Z])/g, "_$1"))}:</dt>
                          <dd className="text-fg-secondary">{formatDetailValue(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {events.length >= ACTIVITY_LIMIT ? (
        <p className="text-fg-muted text-xs">
          Showing the {ACTIVITY_LIMIT} most recent events. Open a specific decision for its complete, fully paginated audit trail.
        </p>
      ) : null}
    </div>
  );
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && ENUM_SHAPE.test(value)) return humanizeEnumValue(value);
  return String(value);
}
