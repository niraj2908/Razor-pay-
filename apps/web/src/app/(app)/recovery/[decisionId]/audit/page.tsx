import Link from "next/link";
import { notFound } from "next/navigation";
import type { ExecutionStatus, OutcomeStatus, RecoveryDecision } from "@prisma/client";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { getDecisionAuditTrail, type AuditEventDTO } from "@/lib/recovery/decisionAuditService";
import { getDecisionDetail } from "@/lib/recovery/decisionDetailService";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Timestamp } from "@/components/ui/Timestamp";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { humanizeAuditAction, humanizeEnumValue } from "@/lib/design/text";
import { DECISION_STATUS, EXECUTION_STATUS, OUTCOME_STATUS, type StatusDescriptor } from "@/lib/design/status";
import { TONE_BORDER, TONE_BG, TONE_ICON } from "@/lib/design/tone";
import { PendingIcon, AuditIcon } from "@/lib/design/icons";

/**
 * Decision Audit Trail (Phase 26 Phase C, screen 5; visual pass redesign).
 * Built entirely around the existing GET /api/recovery/decisions/[decisionId]/audit
 * contract - this page never queries AuditEvent directly and never renders
 * anything beyond what that already-sanitized DTO returns.
 *
 * Each event's marker icon is derived from REAL fields already present in
 * that event's own `details`/`action` (never a generic per-entity-type
 * placeholder): a Decision event's icon comes from `details.selectedAction`
 * (the real RecoveryDecision the engine chose), an Execution event's from
 * its own action verb (`execution.succeeded` -> SUCCEEDED), an Outcome
 * event's from `details.outcomeStatus`. Falls back to a plain pending
 * marker only when none of those real fields are present - never guessed.
 *
 * `details` is rendered key-by-key with humanized labels. Values that are
 * themselves enum-shaped strings (SCREAMING_SNAKE_CASE or snake_case, e.g.
 * "PAYMENT_LINK", "captured_within_window") are humanized the same way the
 * rest of the app humanizes real enums; a value containing a hyphen or
 * digit (a version string like "policy-v1", a reference id like
 * "plink_...") is never touched, since it isn't an enum and humanizing it
 * would corrupt it.
 */
const REDUNDANT_DETAIL_KEYS = new Set(["decisionId", "paymentId"]);

const ENUM_SHAPE = /^[A-Za-z]+(_[A-Za-z]+)*$/;

function resolveMarker(event: AuditEventDTO): StatusDescriptor {
  if (event.entityType === "Decision") {
    const action = event.details.selectedAction;
    if (typeof action === "string" && action in DECISION_STATUS) {
      return DECISION_STATUS[action as RecoveryDecision];
    }
  }
  if (event.entityType === "Execution") {
    const verb = event.action.split(".")[1]?.toUpperCase();
    if (verb && verb in EXECUTION_STATUS) {
      return EXECUTION_STATUS[verb as ExecutionStatus];
    }
  }
  if (event.entityType === "Outcome") {
    const status = event.details.outcomeStatus;
    if (typeof status === "string" && status in OUTCOME_STATUS) {
      return OUTCOME_STATUS[status as OutcomeStatus];
    }
  }
  return { label: event.entityType, tone: "neutral", icon: PendingIcon };
}

export default async function DecisionAuditTrailPage({
  params,
  searchParams,
}: {
  params: Promise<{ decisionId: string }>;
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const { decisionId } = await params;
  const { cursor } = await searchParams;

  if (!isPlausibleId(decisionId)) {
    notFound();
  }

  const [result, decisionResult] = await Promise.all([
    getDecisionAuditTrail(merchantId, decisionId, { cursor }),
    getDecisionDetail(merchantId, decisionId),
  ]);
  if (result.status === "not_found") {
    notFound();
  }
  const decision = decisionResult.status === "found" ? decisionResult.decision : null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href={`/recovery/${decisionId}`} className="text-fg-muted hover:text-fg text-sm">
          &larr; Decision
        </Link>
      </div>

      <PageHeader title="Audit trail" description="Chronological record of this decision, its execution, and its outcome." icon={AuditIcon} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="lg:col-span-8">
          {result.items.length === 0 ? (
            <p className="text-fg-muted text-sm italic">No audit events recorded yet.</p>
          ) : (
            <ol className="flex flex-col gap-5">
              {result.items.map((event) => {
                const marker = resolveMarker(event);
                const MarkerIcon = marker.icon;
                return (
                  <li key={event.id} className="flex gap-3">
                    <div className="flex flex-col items-center pt-0.5">
                      <span
                        aria-hidden="true"
                        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border ${TONE_BORDER[marker.tone]} ${TONE_BG[marker.tone]}`}
                      >
                        <MarkerIcon aria-hidden="true" weight="bold" className={`h-3.5 w-3.5 ${TONE_ICON[marker.tone]}`} />
                      </span>
                      <span className="bg-border mt-1 w-px flex-1" />
                    </div>
                    <div className="flex-1 pb-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-fg text-sm font-medium">{humanizeAuditAction(event.action)}</span>
                        <Timestamp iso={event.createdAt} className="text-fg-muted text-xs" />
                      </div>
                      <div className="text-fg-muted mt-0.5 text-xs">
                        {event.entityType} &middot; {humanizeEnumValue(event.actorType)}
                      </div>
                      <EventDetails details={event.details} />
                    </div>
                  </li>
                );
              })}
            </ol>
          )}

          {result.nextCursor ? (
            <div className="pt-2">
              <Link href={`/recovery/${decisionId}/audit?cursor=${result.nextCursor}`} className="text-info text-sm font-medium hover:underline">
                Older events &rarr;
              </Link>
            </div>
          ) : null}
        </div>

        {decision ? (
          <div className="border-border h-fit rounded-lg border p-5 lg:col-span-4">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">This decision</h2>
            <dl className="flex flex-col gap-3 text-sm">
              <div>
                <dt className="text-fg-muted text-xs">Diagnosis</dt>
                <dd className="text-fg mt-0.5">{humanizeEnumValue(decision.revenueRiskEvent.diagnosis)}</dd>
              </div>
              <div>
                <dt className="text-fg-muted text-xs">Amount at risk</dt>
                <dd className="mt-0.5">
                  <Money value={{ kind: "amount", paise: decision.revenueRiskEvent.amountAtRiskPaise }} size="sm" />
                </dd>
              </div>
              <div>
                <dt className="text-fg-muted text-xs">Decision</dt>
                <dd className="mt-0.5">
                  <StatusBadge {...DECISION_STATUS[decision.decisionType]} />
                </dd>
              </div>
              {decision.execution ? (
                <div>
                  <dt className="text-fg-muted text-xs">Execution</dt>
                  <dd className="mt-0.5">
                    <StatusBadge {...EXECUTION_STATUS[decision.execution.status]} />
                  </dd>
                </div>
              ) : null}
              {decision.outcome ? (
                <div>
                  <dt className="text-fg-muted text-xs">Outcome</dt>
                  <dd className="mt-0.5">
                    <StatusBadge {...OUTCOME_STATUS[decision.outcome.status]} />
                  </dd>
                </div>
              ) : null}
            </dl>
            <Link href={`/recovery/${decisionId}`} className="text-info mt-4 inline-block text-sm font-medium hover:underline">
              View full decision &rarr;
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function EventDetails({ details }: { details: Record<string, unknown> }) {
  const entries = Object.entries(details).filter(([key]) => !REDUNDANT_DETAIL_KEYS.has(key));
  if (entries.length === 0) return null;

  return (
    <dl className="mt-2 flex flex-col gap-1 text-sm">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <dt className="text-fg-muted">{humanizeEnumValue(key.replace(/([A-Z])/g, "_$1"))}:</dt>
          <dd className="text-fg-secondary">{formatDetailValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function formatDetailValue(value: unknown): string {
  if (value === null) return "Not available";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" && ENUM_SHAPE.test(value)) return humanizeEnumValue(value);
  return String(value);
}
