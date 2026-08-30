import Link from "next/link";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { getRecoveryOverview } from "@/lib/recovery/overviewService";
import { listRecoveryQueue } from "@/lib/recovery/recoveryQueueService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ComparisonBar } from "@/components/ui/ComparisonBar";
import { SegmentedBar } from "@/components/ui/SegmentedBar";
import { formatPaiseAsInr } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue } from "@/lib/design/text";
import { DECISION_STATUS } from "@/lib/design/status";
import { WalletIcon, ExecutionIcon, OutcomeIcon, TrendUpIcon, EscalateIcon, OverviewIcon, RecoveryIcon } from "@/lib/design/icons";

/**
 * Recovery Overview - the command center (Phase 26, second visual pass).
 * Every value is read directly from `getRecoveryOverview` or
 * `listRecoveryQueue` (both existing, already-authorized query services) -
 * no invented metric, no chart without a real series behind it, no new
 * backend surface.
 *
 * Full-width 12-column composition, not a narrow centered document:
 * RECOVERY PERFORMANCE (8 cols) + OPERATIONAL ATTENTION (4 cols) on row
 * one, RECOVERY ACTIVITY/DISTRIBUTION (7 cols) + RECOVERY FLOW (5 cols) on
 * row two. Each column's width is used for more real content, never
 * stretched empty space - Operational Attention is the merchant's own
 * highest-value open candidates (a real `listRecoveryQueue` call sorted by
 * amount at risk), not a decorative panel.
 *
 * Two things this page explicitly does NOT chart, and why: (1) a
 * time-based recovery trend - `getRecoveryOverview` returns only current-
 * state/windowed aggregates, never a time-series; (2) a full candidate ->
 * decision -> execution -> outcome funnel - `candidatesCount` is an
 * unwindowed current snapshot while `interventionsAttempted`/
 * `interventionsSucceeded`/`interventionRecoveryCount` are windowed by
 * execution/outcome timestamps (see overviewService's own doc comment);
 * mixing them in one bar would misrepresent them as the same cohort. The
 * "Recovery flow" below uses only the three windowed, causally-connected
 * intervention numbers the API actually returns - not a claim about the
 * full lifecycle, which the API doesn't expose as one connected count.
 */
export default async function OverviewPage() {
  const { merchantId } = await requireAuthContext();
  const [overview, attention] = await Promise.all([
    getRecoveryOverview(merchantId, {}),
    listRecoveryQueue(merchantId, { status: "open", sort: "amountAtRisk_desc", limit: 5 }),
  ]);

  const hasAttention = overview.operational.candidatesCount > 0;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="Current recovery operations for your merchant." icon={OverviewIcon} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* RECOVERY PERFORMANCE */}
        <section className="border-border bg-info/[0.03] flex flex-col gap-5 rounded-lg border p-5 xl:col-span-8">
          <div className="flex items-center gap-2">
            <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
              <WalletIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Recovery performance</h2>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <div>
              <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Revenue at risk now</h3>
              <div className="mt-1">
                <Money value={{ kind: "amount", paise: overview.operational.revenueAtRiskPaise }} size="lg" />
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-sm">
                {hasAttention ? <EscalateIcon aria-hidden="true" weight="bold" className="text-warning h-3.5 w-3.5 shrink-0" /> : null}
                <span className={hasAttention ? "text-fg-secondary" : "text-fg-muted"}>
                  {overview.operational.candidatesCount} open recovery{" "}
                  {overview.operational.candidatesCount === 1 ? "candidate" : "candidates"}
                  {hasAttention ? " requiring attention" : ""}
                </span>
              </p>
            </div>

            <div>
              <h3 className="text-fg-muted flex items-center gap-1.5 text-[11px] font-medium tracking-wider uppercase">
                <TrendUpIcon aria-hidden="true" weight="regular" className="h-3.5 w-3.5" />
                Incremental recovery
              </h3>
              <div className="mt-1">
                <IncrementalRecoverySummary result={overview.incrementalRecovery} />
              </div>
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
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-4">
          <div className="flex items-center gap-2">
            <span className="bg-warning/10 text-warning flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
              <EscalateIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
            </span>
            <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Operational attention</h2>
          </div>
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

        {/* RECOVERY ACTIVITY / DISTRIBUTION */}
        <section className="border-border flex flex-col gap-5 rounded-lg border p-5 xl:col-span-7">
          <div className="flex items-center gap-2">
            <OutcomeIcon aria-hidden="true" weight="regular" className="text-fg-muted h-4 w-4" />
            <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Recovery activity &amp; distribution</h2>
          </div>
          {overview.attributedOutcomes.matureOutcomesCount === 0 ? (
            <p className="text-fg-muted text-sm italic">No outcomes have matured in this period yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
                <span className="text-fg">
                  <span className="font-mono font-medium tabular-nums">{overview.attributedOutcomes.recoveredCount}</span>{" "}
                  recovered of{" "}
                  <span className="font-mono font-medium tabular-nums">{overview.attributedOutcomes.matureOutcomesCount}</span>{" "}
                  mature
                </span>
                <span className="text-fg-secondary">
                  Observed recovery rate:{" "}
                  <span className="font-mono font-medium tabular-nums">
                    {formatPercentOrUnavailable(overview.attributedOutcomes.observedRecoveryRate)}
                  </span>
                </span>
              </div>
              <div>
                <h3 className="text-fg-muted mb-2 text-xs font-medium">Recovered outcomes by attribution</h3>
                <SegmentedBar
                  segments={[
                    { label: "Natural", value: overview.attributedOutcomes.naturalRecoveryCount, displayValue: String(overview.attributedOutcomes.naturalRecoveryCount), className: "bg-recovery-natural" },
                    { label: "Intervention", value: overview.attributedOutcomes.interventionRecoveryCount, displayValue: String(overview.attributedOutcomes.interventionRecoveryCount), className: "bg-recovery-intervention" },
                    { label: "Unknown", value: overview.attributedOutcomes.unknownAttributionCount, displayValue: String(overview.attributedOutcomes.unknownAttributionCount), className: "bg-unknown" },
                  ]}
                />
              </div>
            </>
          )}
        </section>

        {/* RECOVERY FLOW */}
        <section className="border-border flex flex-col gap-4 rounded-lg border p-5 xl:col-span-5">
          <div className="flex items-center gap-2">
            <RecoveryIcon aria-hidden="true" weight="regular" className="text-fg-muted h-4 w-4" />
            <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Recovery flow</h2>
          </div>
          {overview.operational.interventionsAttempted === 0 ? (
            <p className="text-fg-muted text-sm italic">No interventions have been attempted in this period.</p>
          ) : (
            <>
              <ComparisonBar
                maxValue={overview.operational.interventionsAttempted}
                items={[
                  { label: "Attempted", value: overview.operational.interventionsAttempted, displayValue: String(overview.operational.interventionsAttempted), className: "bg-fg-muted" },
                  { label: "Succeeded", value: overview.operational.interventionsSucceeded, displayValue: String(overview.operational.interventionsSucceeded), className: "bg-info" },
                  { label: "Recovered (intervention)", value: overview.attributedOutcomes.interventionRecoveryCount, displayValue: String(overview.attributedOutcomes.interventionRecoveryCount), className: "bg-success" },
                ]}
              />
              <p className="text-fg-muted text-xs">
                Attempted and succeeded are counted by execution; recovered is counted separately by attributed outcome - not a strict
                per-unit funnel, but the three real stages this system tracks for interventions.
              </p>
            </>
          )}
        </section>
      </div>
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
