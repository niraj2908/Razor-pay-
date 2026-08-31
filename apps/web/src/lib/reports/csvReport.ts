import type { ReportData } from "./reportingService";
import { formatPaiseAsInr } from "@/lib/design/money";
import { humanizeEnumValue } from "@/lib/design/text";

/**
 * Plain CSV export for the Operational Report (Phase 28C). Hand-built
 * rather than a new dependency - a CSV writer for this small, fixed set of
 * flat sections is a handful of lines, not worth a library.
 *
 * RFC 4180 field escaping: any field containing a comma, double quote, or
 * newline is wrapped in double quotes with internal quotes doubled - the
 * same rule every real CSV consumer (Excel, Google Sheets) expects.
 */
function escapeCsvField(value: string | number): string {
  const text = String(value);
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function row(fields: Array<string | number>): string {
  return fields.map(escapeCsvField).join(",");
}

export function renderReportCsv(report: ReportData): string {
  const lines: string[] = [];

  lines.push(row(["Revenue Recovery Intelligence - Operational Report"]));
  lines.push(row(["Period since", report.period.since ?? "the beginning"]));
  lines.push(row(["Period until", report.period.until]));
  lines.push(row(["Generated", report.generatedAt]));
  lines.push("");

  lines.push(row(["Executive Summary"]));
  lines.push(row(["Metric", "Value (paise)", "Value"]));
  lines.push(row(["Revenue at risk", report.overview.operational.revenueAtRiskPaise, formatPaiseAsInr(report.overview.operational.revenueAtRiskPaise)]));
  lines.push(row(["Recovery opportunity", report.recoveryOpportunityPaise, formatPaiseAsInr(report.recoveryOpportunityPaise)]));
  const recoveredTotal = report.overview.attributedOutcomes.naturalRecoveryGmvPaise + report.overview.attributedOutcomes.interventionRecoveryGmvPaise;
  lines.push(row(["Recovered", recoveredTotal, formatPaiseAsInr(recoveredTotal)]));
  lines.push("");

  lines.push(row(["Payment Activity"]));
  lines.push(row(["Status", "Count", "Amount (paise)"]));
  for (const [status, v] of Object.entries(report.paymentActivity.byStatus)) {
    lines.push(row([humanizeEnumValue(status), v?.count ?? 0, v?.amountPaise ?? 0]));
  }
  lines.push("");
  lines.push(row(["Method", "Count", "Amount (paise)"]));
  for (const m of report.paymentActivity.byMethod) {
    lines.push(row([humanizeEnumValue(m.method), m.count, m.amountPaise]));
  }
  lines.push("");

  lines.push(row(["Recovery Performance"]));
  lines.push(row(["Attribution", "Count", "Recovered GMV (paise)"]));
  lines.push(row(["Natural recovery", report.overview.attributedOutcomes.naturalRecoveryCount, report.overview.attributedOutcomes.naturalRecoveryGmvPaise]));
  lines.push(row(["Intervention recovery", report.overview.attributedOutcomes.interventionRecoveryCount, report.overview.attributedOutcomes.interventionRecoveryGmvPaise]));
  lines.push(row(["Unknown attribution", report.overview.attributedOutcomes.unknownAttributionCount, ""]));
  lines.push("");

  lines.push(row(["Decision Analysis"]));
  lines.push(row(["Decision", "Open candidates"]));
  lines.push(row(["Act", report.decisionMix.ACT]));
  lines.push(row(["Wait", report.decisionMix.WAIT]));
  lines.push(row(["Stop", report.decisionMix.STOP]));
  lines.push(row(["Escalate", report.decisionMix.ESCALATE]));
  lines.push("");

  lines.push(row(["Experiment Evidence"]));
  lines.push(row(["Experiment", "Status", "Treatment rate", "Control rate", "Incremental GMV (paise)"]));
  for (const experiment of report.experiments) {
    const result = experiment.latestResult;
    lines.push(
      row([
        experiment.name,
        humanizeEnumValue(experiment.status),
        result?.treatment.rate !== null && result?.treatment.rate !== undefined ? result.treatment.rate : "",
        result?.control.rate !== null && result?.control.rate !== undefined ? result.control.rate : "",
        result?.incrementalEstimate.status === "available" ? result.incrementalEstimate.estimatedIncrementalGMVPaise : "",
      ])
    );
  }
  lines.push("");

  lines.push(row(["Audit / Recent Activity"]));
  lines.push(row(["Timestamp", "Action", "Entity type"]));
  for (const event of report.recentActivity) {
    lines.push(row([event.createdAt, event.action, event.entityType]));
  }

  return lines.join("\r\n") + "\r\n";
}
