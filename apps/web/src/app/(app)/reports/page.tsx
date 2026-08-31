import Link from "next/link";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { validateDateRange } from "@/lib/recovery/overviewService";
import { getReportData } from "@/lib/reports/reportingService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { ComparisonBar } from "@/components/ui/ComparisonBar";
import { formatPaiseAsInr } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue, humanizeAuditAction } from "@/lib/design/text";
import { EXPERIMENT_STATUS, DECISION_STATUS } from "@/lib/design/status";
import { ReportsIcon, WalletIcon, TrendUpIcon, OutcomeIcon, PaymentIcon } from "@/lib/design/icons";
import { ReportFilters } from "./ReportFilters";

const MAX_EXPERIMENTS_SHOWN_NOTE = 10;

/**
 * Operations Report (Phase 28C). One page, six honest sections, matching
 * the operational-report structure used by the PDF/CSV exports
 * (`pdfReport.ts`/`csvReport.ts`) so the on-screen view and the downloads
 * never disagree - all three render from the exact same `getReportData`
 * call.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ since?: string; until?: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const params = await searchParams;

  const range = validateDateRange(params.since ?? null, params.until ?? null);
  const safeRange = range.valid ? { since: range.since, until: range.until } : {};

  const report = await getReportData(merchantId, safeRange);

  const sinceInputValue = params.since ?? "";
  const untilInputValue = params.until ?? "";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reports"
        description="Operational reporting across payments, recovery, decisions, and experiment evidence."
        icon={ReportsIcon}
      />

      {/* A full-width row of its own (Phase 28C visual QA fix), not
          PageHeader's `actions` slot: date range + Apply + two export links
          is meaningfully wider than the compact filter bars other pages
          put there (e.g. Recovery Queue's two selects). Squeezed beside the
          title, it doesn't fit and doesn't have room to wrap, causing real
          horizontal page overflow in the 640-1350px range - confirmed via
          `document.documentElement.scrollWidth > window.innerWidth`. Its
          own row can wrap freely regardless of viewport width. */}
      <ReportFilters since={sinceInputValue} until={untilInputValue} />

      {!range.valid ? (
        <p role="alert" className="text-danger text-sm">
          Invalid date range ({humanizeEnumValue(range.reason)}) - showing the full, unfiltered report instead.
        </p>
      ) : null}

      {/* 1. EXECUTIVE SUMMARY */}
      <section className="flex flex-col gap-4">
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">1. Executive summary</h2>
        {/* 2-up before 3-up - see overview/page.tsx's identical fix for why:
            a large Money figure overflowed its column and overlapped its
            neighbor at 3-up starting as early as `sm` (640px). */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <StatCard
            icon={WalletIcon}
            label="Revenue at risk"
            value={<Money value={{ kind: "amount", paise: report.overview.operational.revenueAtRiskPaise }} size="lg" />}
            note="Current state - not affected by the date range below"
          />
          <StatCard
            icon={TrendUpIcon}
            label="Recovery opportunity"
            value={<Money value={{ kind: "amount", paise: report.recoveryOpportunityPaise }} size="lg" />}
            note="Current state - not affected by the date range below"
          />
          <StatCard
            icon={OutcomeIcon}
            label="Recovered"
            value={
              <Money
                value={{
                  kind: "amount",
                  paise: report.overview.attributedOutcomes.naturalRecoveryGmvPaise + report.overview.attributedOutcomes.interventionRecoveryGmvPaise,
                }}
                size="lg"
              />
            }
            note="Within the selected date range"
          />
        </div>
      </section>

      {/* 2. PAYMENT ACTIVITY */}
      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <div className="flex items-center gap-2">
          <PaymentIcon aria-hidden="true" className="text-fg-muted h-4 w-4" />
          <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">2. Payment activity</h2>
        </div>
        <p className="text-fg-secondary text-sm">
          {report.paymentActivity.totalCount} payments totaling <Money value={{ kind: "amount", paise: report.paymentActivity.totalAmountPaise }} size="sm" /> in this period.
        </p>
        {report.paymentActivity.totalCount === 0 ? (
          <p className="text-fg-muted text-sm italic">No payments recorded in this period.</p>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-fg-muted mb-2 text-xs font-medium">By status</h3>
              <ComparisonBar
                items={Object.entries(report.paymentActivity.byStatus).map(([status, v]) => ({
                  label: humanizeEnumValue(status),
                  value: v?.amountPaise ?? 0,
                  displayValue: `${formatPaiseAsInr(v?.amountPaise ?? 0)} (${v?.count ?? 0})`,
                  className: "bg-info",
                }))}
              />
            </div>
            <div>
              <h3 className="text-fg-muted mb-2 text-xs font-medium">By method</h3>
              <ComparisonBar
                items={report.paymentActivity.byMethod.map((m) => ({
                  label: humanizeEnumValue(m.method),
                  value: m.amountPaise,
                  displayValue: `${formatPaiseAsInr(m.amountPaise)} (${m.count})`,
                  className: "bg-fg-muted",
                }))}
              />
            </div>
          </div>
        )}
      </section>

      {/* 3. RECOVERY PERFORMANCE */}
      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <div className="flex items-center gap-2">
          <WalletIcon aria-hidden="true" className="text-fg-muted h-4 w-4" />
          <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">3. Recovery performance</h2>
        </div>
        {report.overview.attributedOutcomes.matureOutcomesCount === 0 ? (
          <p className="text-fg-muted text-sm italic">No outcomes have matured in this period.</p>
        ) : (
          <>
            <ComparisonBar
              items={[
                { label: "Natural recovery", value: report.overview.attributedOutcomes.naturalRecoveryGmvPaise, displayValue: formatPaiseAsInr(report.overview.attributedOutcomes.naturalRecoveryGmvPaise), className: "bg-recovery-natural" },
                { label: "Intervention recovery", value: report.overview.attributedOutcomes.interventionRecoveryGmvPaise, displayValue: formatPaiseAsInr(report.overview.attributedOutcomes.interventionRecoveryGmvPaise), className: "bg-recovery-intervention" },
              ]}
            />
            <p className="text-fg-secondary text-sm">
              Observed recovery rate: <span className="font-mono font-medium tabular-nums">{formatPercentOrUnavailable(report.overview.attributedOutcomes.observedRecoveryRate)}</span> ({report.overview.attributedOutcomes.recoveredCount} of {report.overview.attributedOutcomes.matureOutcomesCount} mature outcomes). Interventions attempted: {report.overview.operational.interventionsAttempted}, succeeded: {report.overview.operational.interventionsSucceeded}.
            </p>
          </>
        )}
      </section>

      {/* 4. DECISION ANALYSIS */}
      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">4. Decision analysis</h2>
        <div className="flex flex-wrap gap-6">
          {(["ACT", "WAIT", "STOP", "ESCALATE"] as const).map((type) => (
            <div key={type} className="flex items-center gap-2">
              <StatusBadge {...DECISION_STATUS[type]} />
              <span className="text-fg font-mono text-sm font-medium tabular-nums">{report.decisionMix[type]}</span>
            </div>
          ))}
        </div>
      </section>

      {/* 5. EXPERIMENT EVIDENCE */}
      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">5. Experiment evidence</h2>
        {report.experiments.length === 0 ? (
          <p className="text-fg-muted text-sm italic">No experiments configured for this merchant.</p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {report.experiments.map((experiment) => (
              <li key={experiment.id} className="flex items-center justify-between gap-3 py-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <Link href={`/experiments/${experiment.id}`} className="text-info truncate text-sm font-medium hover:underline">
                    {experiment.name}
                  </Link>
                  <div className="flex items-center gap-2">
                    <StatusBadge {...EXPERIMENT_STATUS[experiment.status]} />
                    {experiment.latestResult ? (
                      <span className="text-fg-muted text-xs">
                        Treatment {formatPercentOrUnavailable(experiment.latestResult.treatment.rate)} vs. control{" "}
                        {formatPercentOrUnavailable(experiment.latestResult.control.rate)}
                      </span>
                    ) : (
                      <span className="text-fg-muted text-xs italic">No result yet</span>
                    )}
                  </div>
                </div>
                {experiment.latestResult?.incrementalEstimate.status === "available" ? (
                  <Money value={{ kind: "amount", paise: experiment.latestResult.incrementalEstimate.estimatedIncrementalGMVPaise }} size="sm" />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {report.experiments.length >= MAX_EXPERIMENTS_SHOWN_NOTE ? (
          <p className="text-fg-muted text-xs">Showing the {MAX_EXPERIMENTS_SHOWN_NOTE} most recent experiments.</p>
        ) : null}
      </section>

      {/* 6. AUDIT / METHODOLOGY */}
      <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">6. Audit / methodology</h2>
        {report.recentActivity.length === 0 ? (
          <p className="text-fg-muted text-sm italic">No activity recorded yet.</p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {report.recentActivity.slice(0, 10).map((event) => (
              <li key={event.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span className="text-fg-secondary">{humanizeAuditAction(event.action)}</span>
                <Timestamp iso={event.createdAt} className="text-fg-muted text-xs" />
              </li>
            ))}
          </ul>
        )}
        <p className="text-fg-muted border-border border-t pt-3 text-xs">
          Recovered/incremental figures are computed by the application&apos;s Decision Engine, Execution Service, and Outcome
          Attribution logic. Incremental (causal) GMV is reported only when a completed experiment&apos;s measurement result is
          independently validated as a statistically confirmed effect (VALID_EFFECT). Observed differences between treatment and
          control are never presented as causal on their own. This report contains no projections or forecasts beyond what has
          already been observed or validated.
        </p>
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof WalletIcon;
  label: string;
  value: React.ReactNode;
  note?: string;
}) {
  return (
    <div className="border-border rounded-lg border p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">{label}</h3>
      </div>
      {value}
      {note ? <p className="text-fg-muted mt-1.5 text-xs">{note}</p> : null}
    </div>
  );
}
