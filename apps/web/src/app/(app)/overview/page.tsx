import Link from "next/link";
import type { RecoveryDecision } from "@prisma/client";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { getRecoveryOverview, getDecisionMix, getRecoveryOpportunityPaise } from "@/lib/recovery/overviewService";
import { listRecoveryQueue } from "@/lib/recovery/recoveryQueueService";
import { getRecentActivity } from "@/lib/recovery/activityFeedService";
import type { AuditEventDTO } from "@/lib/recovery/decisionAuditService";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { ComparisonBar } from "@/components/ui/ComparisonBar";
import { SegmentedBar } from "@/components/ui/SegmentedBar";
import { formatPaiseAsInr } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue, humanizeAuditAction } from "@/lib/design/text";
import { DECISION_STATUS } from "@/lib/design/status";
import { TONE_BORDER, TONE_BG, TONE_ICON } from "@/lib/design/tone";
import { resolveAuditMarker } from "@/lib/design/auditMarker";
import {
  WalletIcon,
  OutcomeIcon,
  TrendUpIcon,
  EscalateIcon,
  RecoveryIcon,
  ExecutionIcon,
  type IconComponent,
} from "@/lib/design/icons";

/**
 * Recovery Overview - the product's hero screen (Phase 28C redesign, on top
 * of the Phase 26 second visual pass). Every value still traces to a real,
 * already-authorized query service - `getRecoveryOverview`,
 * `listRecoveryQueue` (both pre-existing) plus two new, additive,
 * read-only aggregations this phase added (`getDecisionMix`,
 * `getRecoveryOpportunityPaise` - both plain sums/counts over already-
 * persisted `Decision` fields, no new estimate, no schema change) and a
 * new merchant-wide `getRecentActivity` feed (same audit-sanitization
 * discipline as the per-decision audit trail, generalized).
 *
 * Tells the product story top to bottom: the hero KPI strip is the
 * headline (risk / opportunity / recovered), Recovery Performance and
 * Decision Mix explain HOW the system is currently reasoning about that
 * risk, Recovery Activity is EVIDENCE that it actually acted, and
 * Operational Attention is what still needs a human.
 *
 * Still does NOT chart a time-series trend or a full candidate-to-outcome
 * funnel - `getRecoveryOverview` returns only current-state/windowed
 * aggregates, never a time-series, and mixing an unwindowed current count
 * with windowed execution/outcome counts in one funnel would misrepresent
 * them as the same cohort (see the previous version of this file's own
 * finding). Both are left out rather than faked, per this phase's own
 * "real data only" rule.
 */
export default async function OverviewPage() {
  const { merchantId } = await requireAuthContext();
  const [overview, attention, decisionMix, recoveryOpportunityPaise, activity] = await Promise.all([
    getRecoveryOverview(merchantId, {}),
    listRecoveryQueue(merchantId, { status: "open", sort: "amountAtRisk_desc", limit: 5 }),
    getDecisionMix(merchantId),
    getRecoveryOpportunityPaise(merchantId),
    getRecentActivity(merchantId, 8),
  ]);

  const recoveredTotalPaise = overview.attributedOutcomes.naturalRecoveryGmvPaise + overview.attributedOutcomes.interventionRecoveryGmvPaise;
  const decisionMixTotal = decisionMix.ACT + decisionMix.WAIT + decisionMix.STOP + decisionMix.ESCALATE;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-fg text-2xl font-semibold tracking-tight">Revenue Recovery Intelligence</h1>
        <p className="text-fg-secondary mt-1 text-sm">
          Payment failures, evaluated for risk, decided on by policy, acted upon, and measured for real recovered revenue - for your
          merchant, right now.
        </p>
      </div>

      {/* HERO KPI STRIP */}
      {/* 2-up before 3-up (Phase 28C visual QA fix): at 3 columns starting
          as early as `sm` (640px), a large `Money` figure like
          "₹1,17,598.25" routinely overflowed its ~1/3-width column and
          visibly overlapped its neighbor in the 640-1279px range - a real,
          visible rendering bug on a genuinely common laptop/window width,
          not a hypothetical edge case. Widening to 2-up until `xl` gives
          each figure real room before ever squeezing to three across. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <HeroStat
          icon={WalletIcon}
          tone="warning"
          label="Revenue at risk"
          value={<Money value={{ kind: "amount", paise: overview.operational.revenueAtRiskPaise }} size="lg" />}
          note={`${overview.operational.candidatesCount} open ${overview.operational.candidatesCount === 1 ? "candidate" : "candidates"}`}
        />
        <HeroStat
          icon={TrendUpIcon}
          tone="info"
          label="Recovery opportunity"
          value={<Money value={{ kind: "amount", paise: recoveryOpportunityPaise }} size="lg" />}
          note="Expected incremental value of currently open decisions"
        />
        <HeroStat
          icon={OutcomeIcon}
          tone="success"
          label="Recovered"
          value={<Money value={{ kind: "amount", paise: recoveredTotalPaise }} size="lg" />}
          note={`${overview.attributedOutcomes.recoveredCount} of ${overview.attributedOutcomes.matureOutcomesCount} mature outcomes`}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* RECOVERY PERFORMANCE */}
        <section className="border-border bg-info/[0.03] flex flex-col gap-5 rounded-lg border p-5 xl:col-span-7">
          <SectionHeading icon={WalletIcon} tone="info" title="Recovery performance" />

          <div>
            <h3 className="text-fg-muted flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
              <TrendUpIcon aria-hidden="true" className="h-3.5 w-3.5" />
              Incremental recovery (causal)
            </h3>
            <div className="mt-1">
              <IncrementalRecoverySummary result={overview.incrementalRecovery} />
            </div>
          </div>

          <div className="border-border border-t pt-5">
            <h3 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wider uppercase">
              Recovered GMV by attribution <span className="normal-case">&middot; since {overview.period.since ?? "the beginning"}</span>
            </h3>
            {overview.attributedOutcomes.matureOutcomesCount === 0 ? (
              <p className="text-fg-muted text-sm italic">No outcomes have matured in this period yet.</p>
            ) : (
              <ComparisonBar
                items={[
                  {
                    label: "Natural recovery",
                    value: overview.attributedOutcomes.naturalRecoveryGmvPaise,
                    displayValue: formatPaiseAsInr(overview.attributedOutcomes.naturalRecoveryGmvPaise),
                    className: "bg-recovery-natural",
                  },
                  {
                    label: "Intervention recovery",
                    value: overview.attributedOutcomes.interventionRecoveryGmvPaise,
                    displayValue: formatPaiseAsInr(overview.attributedOutcomes.interventionRecoveryGmvPaise),
                    className: "bg-recovery-intervention",
                  },
                ]}
              />
            )}
          </div>
        </section>

        {/* OPERATIONAL ATTENTION */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-5">
          <SectionHeading icon={EscalateIcon} tone="warning" title="Operational attention" />
          {attention.items.length === 0 ? (
            <p className="text-fg-muted text-sm italic">No open recovery candidates right now.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {attention.items.map((item) => {
                const body = (
                  <div className="flex items-center justify-between gap-3 py-2.5">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className={`truncate text-sm font-medium ${item.decision ? "text-info" : "text-fg"}`}>
                        {humanizeEnumValue(item.diagnosis)}
                      </span>
                      {item.decision ? (
                        <StatusBadge {...DECISION_STATUS[item.decision.decisionType]} />
                      ) : (
                        <span className="text-fg-muted text-xs italic">Awaiting decision</span>
                      )}
                    </div>
                    <Money value={{ kind: "amount", paise: item.amountAtRiskPaise }} size="sm" />
                  </div>
                );
                return (
                  <li key={item.id}>
                    {item.decision ? (
                      <Link href={`/recovery/${item.decision.id}`} className="block">
                        {body}
                      </Link>
                    ) : (
                      body
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Link href="/recovery" className="text-info mt-auto text-sm font-medium hover:underline">
            View full queue &rarr;
          </Link>
        </section>

        {/* DECISION MIX */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-4">
          <SectionHeading icon={DECISION_STATUS.ACT.icon} tone="neutral" title="Decision mix" />
          {decisionMixTotal === 0 ? (
            <p className="text-fg-muted text-sm italic">No open candidates have a decision yet.</p>
          ) : (
            <>
              <SegmentedBar
                segments={(["ACT", "WAIT", "STOP", "ESCALATE"] as RecoveryDecision[]).map((type) => ({
                  label: DECISION_STATUS[type].label,
                  value: decisionMix[type],
                  displayValue: String(decisionMix[type]),
                  className: DECISION_MIX_BG[type],
                }))}
              />
              <p className="text-fg-muted text-xs">The Decision Engine&apos;s most recent call on each currently-open recovery candidate.</p>
            </>
          )}
        </section>

        {/* OUTCOME DISTRIBUTION */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-4">
          <SectionHeading icon={OutcomeIcon} tone="neutral" title="Outcome distribution" />
          {overview.attributedOutcomes.matureOutcomesCount === 0 ? (
            <p className="text-fg-muted text-sm italic">No outcomes have matured in this period yet.</p>
          ) : (
            <>
              <div className="text-fg-secondary text-sm">
                Observed recovery rate:{" "}
                <span className="font-mono font-medium tabular-nums">
                  {formatPercentOrUnavailable(overview.attributedOutcomes.observedRecoveryRate)}
                </span>
              </div>
              <SegmentedBar
                segments={[
                  { label: "Natural", value: overview.attributedOutcomes.naturalRecoveryCount, displayValue: String(overview.attributedOutcomes.naturalRecoveryCount), className: "bg-recovery-natural" },
                  { label: "Intervention", value: overview.attributedOutcomes.interventionRecoveryCount, displayValue: String(overview.attributedOutcomes.interventionRecoveryCount), className: "bg-recovery-intervention" },
                  { label: "Unknown", value: overview.attributedOutcomes.unknownAttributionCount, displayValue: String(overview.attributedOutcomes.unknownAttributionCount), className: "bg-unknown" },
                ]}
              />
            </>
          )}
        </section>

        {/* RECOVERY FLOW */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-4">
          <SectionHeading icon={RecoveryIcon} tone="neutral" title="Recovery flow" />
          {overview.operational.interventionsAttempted === 0 ? (
            <p className="text-fg-muted text-sm italic">No interventions have been attempted in this period.</p>
          ) : (
            <ComparisonBar
              maxValue={overview.operational.interventionsAttempted}
              items={[
                { label: "Attempted", value: overview.operational.interventionsAttempted, displayValue: String(overview.operational.interventionsAttempted), className: "bg-fg-muted" },
                { label: "Succeeded", value: overview.operational.interventionsSucceeded, displayValue: String(overview.operational.interventionsSucceeded), className: "bg-info" },
                { label: "Recovered", value: overview.attributedOutcomes.interventionRecoveryCount, displayValue: String(overview.attributedOutcomes.interventionRecoveryCount), className: "bg-success" },
              ]}
            />
          )}
        </section>

        {/* RECOVERY ACTIVITY */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-12">
          <SectionHeading icon={ExecutionIcon} tone="neutral" title="Recovery activity" />
          {activity.length === 0 ? (
            <p className="text-fg-muted text-sm italic">No decisions, executions, or outcomes recorded yet.</p>
          ) : (
            <ol className="divide-border grid grid-cols-1 divide-y sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0 xl:grid-cols-4">
              {activity.map((event) => (
                <ActivityRow key={event.id} event={event} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}

const DECISION_MIX_BG: Record<RecoveryDecision, string> = {
  ACT: "bg-success",
  WAIT: "bg-info",
  STOP: "bg-danger",
  ESCALATE: "bg-warning",
};

function HeroStat({
  icon: Icon,
  tone,
  label,
  value,
  note,
}: {
  icon: IconComponent;
  tone: "warning" | "info" | "success";
  label: string;
  value: React.ReactNode;
  note: string;
}) {
  const toneBg = tone === "warning" ? "bg-warning/10 text-warning" : tone === "info" ? "bg-info/10 text-info" : "bg-success/10 text-success";
  return (
    <div className="border-border rounded-lg border p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${toneBg}`}>
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">{label}</h2>
      </div>
      {value}
      <p className="text-fg-muted mt-2 text-sm">{note}</p>
    </div>
  );
}

function SectionHeading({
  icon: Icon,
  tone,
  title,
}: {
  icon: IconComponent;
  tone: "info" | "warning" | "neutral";
  title: string;
}) {
  const toneBg = tone === "info" ? "bg-info/10 text-info" : tone === "warning" ? "bg-warning/10 text-warning" : "bg-surface-subtle text-fg-muted";
  return (
    <div className="flex items-center gap-2">
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-sm ${toneBg}`}>
        <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
      <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">{title}</h2>
    </div>
  );
}

function IncrementalRecoverySummary({
  result,
}: {
  result: Awaited<ReturnType<typeof getRecoveryOverview>>["incrementalRecovery"];
}) {
  if (result.status === "available") {
    return (
      <div>
        <Money value={{ kind: "amount", paise: result.estimatedIncrementalGMVPaise }} size="md" />
        <p className="text-fg-secondary mt-1 text-xs">Validated from a completed experiment with a statistically confirmed effect.</p>
      </div>
    );
  }

  const REASON_COPY: Record<typeof result.reason, string> = {
    no_experiment_configured: "No experiment has been configured for this merchant yet.",
    no_valid_effect_result: "No experiment has produced a statistically validated effect yet.",
    ambiguous_multiple_valid_effect_experiments:
      "Multiple experiments show a validated effect. Which one represents merchant-wide incremental recovery is not yet defined.",
  };

  return <p className="text-fg-muted text-sm italic">{REASON_COPY[result.reason]}</p>;
}

function ActivityRow({ event }: { event: AuditEventDTO }) {
  const marker = resolveAuditMarker(event);
  const MarkerIcon = marker.icon;
  return (
    <li className="flex items-start gap-2.5 py-2.5 sm:py-1.5">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${TONE_BORDER[marker.tone]} ${TONE_BG[marker.tone]}`}
      >
        <MarkerIcon aria-hidden="true" className={`h-3 w-3 ${TONE_ICON[marker.tone]}`} />
      </span>
      <div className="min-w-0">
        <div className="text-fg truncate text-sm font-medium">{humanizeAuditAction(event.action)}</div>
        <Timestamp iso={event.createdAt} className="text-fg-muted text-xs" />
      </div>
    </li>
  );
}
