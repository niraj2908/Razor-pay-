import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import {
  getExperimentDetail,
  listExperimentResults,
  type MeasurementResultDTO,
} from "@/lib/experiments/measurement/experimentQueryService";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { ComparisonBar } from "@/components/ui/ComparisonBar";
import { SegmentedBar } from "@/components/ui/SegmentedBar";
import { ConfidenceIntervalBar } from "@/components/ui/ConfidenceIntervalBar";
import { EXPERIMENT_STATUS, MEASUREMENT_STATUS, OUTCOME_STATUS } from "@/lib/design/status";
import { formatPercent } from "@/lib/design/percent";
import { formatPaiseAsInr } from "@/lib/design/money";
import { humanizeEnumValue } from "@/lib/design/text";
import { ExperimentIcon } from "@/lib/design/icons";

/**
 * Experiment Detail + Result - a workbench, not a CRUD form (Phase 26,
 * second visual pass). Full width, not centered in a narrow column: the
 * measurement result splits into an OBSERVED column (the raw treatment/
 * control table and bars - what was measured) and a STATISTICAL EVIDENCE
 * column (confidence interval, incremental/causal estimate, exclusions,
 * validity checks, methodology - whether that observation is trustworthy
 * enough to act on) so the visual layout itself makes the observed-vs-
 * causal distinction impossible to miss, not just the wording.
 *
 * `incrementalEstimate` is rendered as "available" ONLY when the DTO
 * itself says `status: "available"` - VALID_INCONCLUSIVE/INVALID/
 * INSUFFICIENT_DATA (and VALID_EFFECT with an unexpectedly-null estimate)
 * always render as unavailable. `observedDifference` is always labeled
 * "observed", never relabeled as an effect. The treatment/control table
 * stays the primary, precise representation (per ui-ux-pro-max's own
 * category-comparison chart guidance) - the `ComparisonBar`s are a visual
 * supplement, every exact value printed as text beside its bar.
 */
export default async function ExperimentDetailPage({ params }: { params: Promise<{ experimentId: string }> }) {
  const { merchantId } = await requireAuthContext();
  const { experimentId } = await params;

  if (!isPlausibleId(experimentId)) {
    notFound();
  }

  const result = await getExperimentDetail(merchantId, experimentId);
  if (result.status === "not_found") {
    notFound();
  }
  const experiment = result.experiment;

  const history = await listExperimentResults(merchantId, experimentId, {});

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/experiments" className="text-fg-muted hover:text-fg text-sm">
          &larr; Experiments
        </Link>
      </div>

      <PageHeader title={experiment.name} description={experiment.hypothesis ?? undefined} icon={ExperimentIcon} />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <section className="border-border rounded-lg border p-5 xl:col-span-8">
          <div className="mb-4 flex items-center gap-3">
            <StatusBadge {...EXPERIMENT_STATUS[experiment.status]} />
            <span className="text-fg-muted text-sm">Version {experiment.version}</span>
          </div>
          <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Configuration</h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Field label="Treatment" value={experiment.treatmentDefinition} />
            <Field label="Control" value={experiment.controlDefinition} />
            <Field label="Traffic allocation" value={formatPercent(experiment.trafficAllocationPercent / 100, 0)} />
            <Field label="Started" value={experiment.startedAt ? <Timestamp iso={experiment.startedAt} /> : "Not started"} />
            <Field label="Ended" value={experiment.endedAt ? <Timestamp iso={experiment.endedAt} /> : "Not ended"} />
          </dl>
          {experiment.description ? <p className="text-fg-secondary mt-3 text-sm">{experiment.description}</p> : null}
        </section>

        <section className="border-border rounded-lg border p-5 xl:col-span-4">
          <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Traffic split</h2>
          <SegmentedBar
            segments={[
              { label: "Treatment", value: experiment.treatmentAllocationPercent, displayValue: formatPercent(experiment.treatmentAllocationPercent / 100, 0), className: "bg-treatment" },
              { label: "Control", value: 100 - experiment.treatmentAllocationPercent, displayValue: formatPercent((100 - experiment.treatmentAllocationPercent) / 100, 0), className: "bg-control" },
            ]}
          />
          <p className="text-fg-muted mt-3 text-xs">Of the {formatPercent(experiment.trafficAllocationPercent / 100, 0)} of traffic included in this experiment.</p>
        </section>

        <section className="xl:col-span-12">
          <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Latest measurement result</h2>
          {experiment.latestResult ? (
            <MeasurementResultView result={experiment.latestResult} />
          ) : (
            <p className="text-fg-muted text-sm italic">No measurement has been computed for this experiment yet.</p>
          )}
        </section>

        {history.status === "found" && history.items.length > 1 ? (
          <section className="border-border border-t pt-5 xl:col-span-12">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Result history</h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-fg-muted border-b text-left text-[11px] font-medium tracking-wider uppercase">
                  <th className="py-2 pr-4 font-medium">Version</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 font-medium">Generated</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {history.items.map((item) => (
                  <tr key={item.id}>
                    <td className="text-fg py-2 pr-4 font-mono tabular-nums">{item.version}</td>
                    <td className="text-fg-secondary py-2 pr-4">{humanizeEnumValue(item.resultKind)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge {...MEASUREMENT_STATUS[item.resultStatus]} />
                    </td>
                    <td className="py-2">
                      <Timestamp iso={item.generatedAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function MeasurementResultView({ result }: { result: MeasurementResultDTO }) {
  return (
    <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-12">
      {/* OBSERVED: the raw treatment/control measurement. `items-start` on
          the parent grid lets this panel end where its own content ends -
          forcing it to match STATISTICAL EVIDENCE's height (which usually
          has more to show: incremental estimate, exclusions, validity
          checks, methodology) just left dead space at the bottom of the
          shorter box. */}
      <div className="border-border flex flex-col gap-5 rounded-lg border p-5 xl:col-span-7">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Observed &middot; treatment vs. control</h3>
          <span className="text-fg-muted text-xs">
            Generated <Timestamp iso={result.generatedAt} className="inline text-fg-muted text-xs" />
          </span>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-fg-muted border-b text-left text-xs">
              <th className="py-1.5 pr-4 font-medium"></th>
              <th className="py-1.5 pr-4 font-medium">Analyzable</th>
              <th className="py-1.5 pr-4 font-medium">Successes</th>
              <th className="py-1.5 pr-4 font-medium">Rate</th>
              <th className="py-1.5 font-medium">Recovered GMV</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            <ArmRow label="Treatment" arm={result.treatment} />
            <ArmRow label="Control" arm={result.control} />
          </tbody>
        </table>

        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <h4 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wide uppercase">Recovery rate</h4>
            <ComparisonBar
              items={[
                { label: "Treatment", value: result.treatment.rate ?? 0, displayValue: result.treatment.rate !== null ? formatPercent(result.treatment.rate) : "Not available", className: "bg-treatment" },
                { label: "Control", value: result.control.rate ?? 0, displayValue: result.control.rate !== null ? formatPercent(result.control.rate) : "Not available", className: "bg-control" },
              ]}
            />
          </div>
          <div>
            <h4 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wide uppercase">Recovered GMV</h4>
            <ComparisonBar
              items={[
                { label: "Treatment", value: result.treatment.recoveredGMVPaise, displayValue: formatPaiseAsInr(result.treatment.recoveredGMVPaise), className: "bg-treatment" },
                { label: "Control", value: result.control.recoveredGMVPaise, displayValue: formatPaiseAsInr(result.control.recoveredGMVPaise), className: "bg-control" },
              ]}
            />
          </div>
        </div>

        <div>
          <h4 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wide uppercase">Observed difference</h4>
          {result.observedDifference ? (
            <div className="max-w-sm">
              <ConfidenceIntervalBar
                lower={result.observedDifference.lower}
                point={result.observedDifference.observedDifference}
                upper={result.observedDifference.upper}
                label="95% CI"
              />
            </div>
          ) : (
            <p className="text-fg-muted text-sm italic">Not available.</p>
          )}
          <p className="text-fg-muted mt-2 text-xs">A raw sample statistic - observed, not a causal claim on its own.</p>
        </div>
      </div>

      {/* STATISTICAL EVIDENCE: is the observed difference trustworthy / causal */}
      <div className="bg-surface-subtle/50 flex flex-col gap-5 rounded-lg p-5 xl:col-span-5">
        <div className="flex items-center gap-3">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Statistical evidence</h3>
          <StatusBadge {...MEASUREMENT_STATUS[result.resultStatus]} />
        </div>

        <div>
          <h4 className="text-fg-muted mb-1 text-[11px] font-medium tracking-wide uppercase">Incremental recovered GMV (causal)</h4>
          {result.incrementalEstimate.status === "available" ? (
            <div className="flex flex-col gap-3">
              <Money value={{ kind: "amount", paise: result.incrementalEstimate.estimatedIncrementalGMVPaise }} size="md" />
              <ComparisonBar
                items={[
                  { label: "Actual treatment GMV", value: result.treatment.recoveredGMVPaise, displayValue: formatPaiseAsInr(result.treatment.recoveredGMVPaise), className: "bg-treatment" },
                  {
                    label: "Estimated counterfactual GMV",
                    value: result.incrementalEstimate.estimatedCounterfactualTreatmentGMVPaise,
                    displayValue: formatPaiseAsInr(result.incrementalEstimate.estimatedCounterfactualTreatmentGMVPaise),
                    className: "bg-control",
                  },
                ]}
              />
            </div>
          ) : (
            <p className="text-fg-muted text-sm italic">
              Not available - this result does not meet the threshold for a validated causal effect.
            </p>
          )}
        </div>

        <div className="border-border border-t pt-4">
          <h4 className="text-fg-muted mb-1 text-[11px] font-medium tracking-wide uppercase">Exclusions</h4>
          <p className="text-fg-secondary text-sm">
            {result.exclusions.totalExcluded} unit{result.exclusions.totalExcluded === 1 ? "" : "s"} excluded
            {Object.keys(result.exclusions.reasonCounts).length > 0 ? (
              <>
                :{" "}
                {Object.entries(result.exclusions.reasonCounts)
                  .map(([reason, count]) => `${humanizeEnumValue(reason)} (${count})`)
                  .join(", ")}
              </>
            ) : null}
          </p>
        </div>

        <div className="border-border border-t pt-4">
          <h4 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wide uppercase">Validity checks</h4>
          <ul className="flex flex-col gap-1.5 text-sm">
            {result.validity.checks.map((check, i) => (
              <li key={i} className="flex items-start gap-2">
                <StatusBadge
                  label={check.passed ? "Pass" : "Fail"}
                  tone={check.passed ? "success" : check.severity === "ERROR" ? "danger" : "warning"}
                  icon={check.passed ? OUTCOME_STATUS.RECOVERED.icon : OUTCOME_STATUS.NOT_RECOVERED.icon}
                />
                <span className="text-fg-secondary">{check.message}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="border-border text-fg-muted flex flex-col gap-1 border-t pt-4 text-xs">
          <span>Confidence level: {formatPercent(result.methodology.confidenceLevel, 0)}</span>
          <span>Statistical method: {result.methodology.statisticalMethodVersion}</span>
          <span>Eligibility logic: {result.methodology.eligibilityLogicVersion}</span>
          <span>Validity logic: {result.methodology.validityLogicVersion}</span>
        </div>
      </div>
    </div>
  );
}

function ArmRow({ label, arm }: { label: string; arm: MeasurementResultDTO["treatment"] }) {
  return (
    <tr>
      <td className="text-fg py-1.5 pr-4 font-medium">{label}</td>
      <td className="text-fg-secondary py-1.5 pr-4 font-mono tabular-nums">{arm.analyzableUnits}</td>
      <td className="text-fg-secondary py-1.5 pr-4 font-mono tabular-nums">{arm.successUnits}</td>
      <td className="text-fg-secondary py-1.5 pr-4 font-mono tabular-nums">
        {arm.rate !== null ? formatPercent(arm.rate) : "Not available"}
      </td>
      <td className="py-1.5">
        <Money value={{ kind: "amount", paise: arm.recoveredGMVPaise }} size="sm" />
      </td>
    </tr>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-fg-muted text-xs">{label}</dt>
      <dd className="text-fg mt-0.5">{value}</dd>
    </div>
  );
}
