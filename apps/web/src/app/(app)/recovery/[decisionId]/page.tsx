import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { getDecisionDetail } from "@/lib/recovery/decisionDetailService";
import { isPlausibleId } from "@/lib/recovery/recoveryQueueService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { ProcessTimeline, type TimelineNode } from "@/components/ui/ProcessTimeline";
import { DECISION_STATUS, EXECUTION_STATUS, OUTCOME_STATUS } from "@/lib/design/status";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue } from "@/lib/design/text";
import { PendingIcon, ExecutionIcon, OutcomeIcon, AuditIcon, PaymentIcon, WalletIcon } from "@/lib/design/icons";

/**
 * Decision Detail - an investigation workbench (Phase 26, second visual
 * pass; Phase 28C extended the timeline to the full product story). The
 * `ProcessTimeline` is the primary lifecycle anchor at the top, full width,
 * now spanning Payment -> Risk detected -> Decision -> Execution -> Outcome
 * (the first two nodes use `decision.payment.createdAt`/
 * `decision.revenueRiskEvent.detectedAt`, both already present in the
 * existing DTO - no backend change). Below it, a two-column desktop composition: LEFT (8
 * cols) is the decision itself and why it was made - recovery opportunity,
 * recommended action, decision context, drivers, model predictions. RIGHT
 * (4 cols, one bordered panel) is supporting context - payment, and a
 * compact execution/outcome summary - so the operator reads the "what and
 * why" as the primary document and the "supporting facts" alongside it,
 * never scrolling through a single long undifferentiated column. Single
 * column at `lg` and below - only every field that already exists is
 * used, nothing added.
 *
 * A foreign-merchant or nonexistent decisionId both resolve to
 * `{status: "not_found"}` from the service - rendered as a real 404 via
 * `notFound()`, never a different page shape that could leak which case
 * it was.
 */
export default async function DecisionDetailPage({
  params,
}: {
  params: Promise<{ decisionId: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const { decisionId } = await params;

  if (!isPlausibleId(decisionId)) {
    notFound();
  }

  const result = await getDecisionDetail(merchantId, decisionId);
  if (result.status === "not_found") {
    notFound();
  }

  const decision = result.decision;

  const timelineNodes: TimelineNode[] = [
    {
      icon: PaymentIcon,
      label: "Payment",
      tone: "neutral",
      sublabel: <Timestamp iso={decision.payment.createdAt} className="text-fg-muted text-[11px]" />,
      done: true,
    },
    {
      icon: WalletIcon,
      label: "Risk detected",
      tone: "warning",
      sublabel: <Timestamp iso={decision.revenueRiskEvent.detectedAt} className="text-fg-muted text-[11px]" />,
      done: true,
    },
    {
      icon: DECISION_STATUS[decision.decisionType].icon,
      label: DECISION_STATUS[decision.decisionType].label,
      tone: DECISION_STATUS[decision.decisionType].tone,
      sublabel: <Timestamp iso={decision.decidedAt} className="text-fg-muted text-[11px]" />,
      done: true,
    },
    decision.execution
      ? {
          icon: EXECUTION_STATUS[decision.execution.status].icon,
          label: EXECUTION_STATUS[decision.execution.status].label,
          tone: EXECUTION_STATUS[decision.execution.status].tone,
          sublabel: <Timestamp iso={decision.execution.executedAt} className="text-fg-muted text-[11px]" />,
          done: true,
        }
      : { icon: PendingIcon, label: "No execution", tone: "neutral", done: false },
    decision.outcome
      ? {
          icon: OUTCOME_STATUS[decision.outcome.status].icon,
          label: OUTCOME_STATUS[decision.outcome.status].label,
          tone: OUTCOME_STATUS[decision.outcome.status].tone,
          sublabel: <Timestamp iso={decision.outcome.observedAt} className="text-fg-muted text-[11px]" />,
          done: true,
        }
      : { icon: PendingIcon, label: "No outcome", tone: "neutral", done: false },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/recovery" className="text-fg-muted hover:text-fg text-sm">
          &larr; Recovery queue
        </Link>
      </div>

      <PageHeader
        title="Decision"
        description={`Decided ${new Date(decision.decidedAt).toLocaleString("en-IN")}`}
        icon={DECISION_STATUS[decision.decisionType].icon}
        actions={
          <Link href={`/recovery/${decision.id}/audit`} className="text-info flex items-center gap-1.5 text-sm font-medium hover:underline">
            <AuditIcon aria-hidden="true" className="h-4 w-4" />
            View audit trail &rarr;
          </Link>
        }
      />

      <section className="border-border bg-surface-subtle/50 rounded-lg border p-5">
        <ProcessTimeline nodes={timelineNodes} />
      </section>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* LEFT / PRIMARY: the decision and why it was made */}
        <div className="divide-border flex flex-col divide-y lg:col-span-8">
          <section className="pb-5">
            <div className="flex items-baseline gap-4">
              <StatusBadge {...DECISION_STATUS[decision.decisionType]} />
              {decision.expectedIncrementalValuePaise !== null ? (
                <span className="text-fg-secondary text-sm">
                  Expected incremental value: <Money value={{ kind: "amount", paise: decision.expectedIncrementalValuePaise }} size="sm" />
                </span>
              ) : null}
            </div>
          </section>

          <section className="py-5">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Recovery opportunity</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
              <Field label="Diagnosis" value={humanizeEnumValue(decision.revenueRiskEvent.diagnosis)} />
              <Field label="Amount at risk" value={<Money value={{ kind: "amount", paise: decision.revenueRiskEvent.amountAtRiskPaise }} size="sm" />} />
              <Field
                label="Natural recovery probability"
                value={formatPercentOrUnavailable(decision.revenueRiskEvent.naturalRecoveryProbability)}
              />
              <Field label="Detected" value={<Timestamp iso={decision.revenueRiskEvent.detectedAt} />} />
              <Field
                label="Resolved"
                value={decision.revenueRiskEvent.resolvedAt ? <Timestamp iso={decision.revenueRiskEvent.resolvedAt} /> : "Not yet resolved"}
              />
              <Field label="Data source" value={humanizeEnumValue(decision.revenueRiskEvent.dataSource)} />
            </dl>
          </section>

          <section className="py-5">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Recommended action</h2>
            {decision.chosenAction ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <Field label="Action" value={humanizeEnumValue(decision.chosenAction.actionType)} />
                <Field label="Predicted success probability" value={formatPercentOrUnavailable(decision.chosenAction.predictedSuccessProbability)} />
                <Field label="Estimated cost" value={<Money value={{ kind: "amount", paise: decision.chosenAction.estimatedCostPaise }} size="sm" />} />
                <Field label="Expected net value" value={<Money value={{ kind: "amount", paise: decision.chosenAction.expectedNetValuePaise }} size="sm" />} />
              </dl>
            ) : (
              <p className="text-fg-muted text-sm italic">
                No action was chosen ({humanizeEnumValue(decision.decisionType).toLowerCase()} decisions never select an action).
              </p>
            )}
          </section>

          <section className="py-5">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Decision context</h2>
            {decision.decisionContext ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
                <Field label="Policy version" value={decision.decisionContext.policyVersion ?? "Not available"} />
                <Field label="Model version" value={decision.decisionContext.modelVersion ?? "Not available"} />
                <Field label="Reason" value={decision.decisionContext.reason ? humanizeEnumValue(decision.decisionContext.reason) : "Not available"} />
              </dl>
            ) : (
              <p className="text-fg-muted text-sm italic">No decision context recorded.</p>
            )}
          </section>

          <section className="py-5">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Decision drivers</h2>
            {decision.decisionDrivers.length === 0 ? (
              <p className="text-fg-muted text-sm italic">No decision drivers recorded for this decision.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {decision.decisionDrivers.map((driver, i) => (
                  <li key={i} className="flex items-center gap-2">
                    {driver.passed !== null ? (
                      <StatusBadge
                        label={driver.passed ? "Passed" : "Failed"}
                        tone={driver.passed ? "success" : "danger"}
                        icon={driver.passed ? OUTCOME_STATUS.RECOVERED.icon : OUTCOME_STATUS.NOT_RECOVERED.icon}
                      />
                    ) : null}
                    <span className="text-fg-secondary">{driver.label}</span>
                    {driver.value ? <span className="text-fg-muted">&middot; {driver.value}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="pt-5 last:pb-0">
            <h2 className="text-fg-muted mb-3 text-[11px] font-medium tracking-wider uppercase">Model predictions</h2>
            {decision.modelPredictions.length === 0 ? (
              <p className="text-fg-muted text-sm italic">No model predictions recorded for this decision.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {decision.modelPredictions.map((prediction, i) => (
                  <li key={i} className="text-fg-secondary">
                    <span className="text-fg font-medium">{prediction.modelName}</span> ({prediction.modelVersion}):{" "}
                    <span className="font-mono tabular-nums">{prediction.predictedValue}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* RIGHT / SECONDARY: supporting context */}
        <div className="border-border divide-border flex flex-col divide-y rounded-lg border lg:col-span-4 lg:self-start">
          <section className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <PaymentIcon aria-hidden="true" className="text-fg-muted h-4 w-4" />
              <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Payment</h2>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Field label="Amount" value={<Money value={{ kind: "amount", paise: decision.payment.amountPaise }} size="sm" />} />
              <Field label="Currency" value={decision.payment.currency} />
              <Field label="Method" value={decision.payment.method ? humanizeEnumValue(decision.payment.method) : "Not available"} />
              <Field label="Status" value={humanizeEnumValue(decision.payment.status)} />
              <Field label="Created" value={<Timestamp iso={decision.payment.createdAt} className="text-fg text-sm" />} />
            </dl>
          </section>

          <section className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <ExecutionIcon aria-hidden="true" className="text-fg-muted h-4 w-4" />
              <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Execution</h2>
            </div>
            {decision.execution ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label="Action" value={humanizeEnumValue(decision.execution.actionType)} />
                <Field label="Status" value={<StatusBadge {...EXECUTION_STATUS[decision.execution.status]} />} />
                <Field label="Razorpay reference" value={decision.execution.razorpayReferenceId ?? "Not available"} />
                <Field label="Executed" value={<Timestamp iso={decision.execution.executedAt} className="text-fg text-sm" />} />
                <Field
                  label="Completed"
                  value={decision.execution.completedAt ? <Timestamp iso={decision.execution.completedAt} className="text-fg text-sm" /> : "Not yet completed"}
                />
              </dl>
            ) : (
              <p className="text-fg-muted text-sm italic">No execution occurred for this decision.</p>
            )}
          </section>

          <section className="p-5">
            <div className="mb-3 flex items-center gap-2">
              <OutcomeIcon aria-hidden="true" className="text-fg-muted h-4 w-4" />
              <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Outcome</h2>
            </div>
            {decision.outcome ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Field label="Status" value={<StatusBadge {...OUTCOME_STATUS[decision.outcome.status]} />} />
                <Field label="Attribution" value={decision.outcome.attributionStatus ? humanizeEnumValue(decision.outcome.attributionStatus) : "Not yet attributed"} />
                <Field
                  label="Recovered amount"
                  value={
                    decision.outcome.recoveredAmountPaise !== null ? (
                      <Money value={{ kind: "amount", paise: decision.outcome.recoveredAmountPaise }} size="sm" />
                    ) : (
                      <Money value={{ kind: "unavailable" }} size="sm" />
                    )
                  }
                />
                <Field label="Observed" value={<Timestamp iso={decision.outcome.observedAt} className="text-fg text-sm" />} />
              </dl>
            ) : (
              <p className="text-fg-muted text-sm italic">No outcome has been recorded yet.</p>
            )}
          </section>
        </div>
      </div>
    </div>
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
