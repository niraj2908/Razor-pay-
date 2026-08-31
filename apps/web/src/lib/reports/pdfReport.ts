import pdfMake from "pdfmake";
import standardFonts from "pdfmake/standard-fonts/Helvetica.js";
import type { ReportData } from "./reportingService";
import { formatPaiseAsInr as formatPaiseAsInrWithSymbol } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue, humanizeAuditAction } from "@/lib/design/text";

/**
 * PDFKit's standard Helvetica font (the base-14 PDF font this report
 * intentionally uses - see this module's own doc comment on why no font
 * file is embedded) has no glyph for the Indian Rupee sign (U+20B9) - it
 * renders as a broken/substituted character. The on-screen page and the
 * CSV export both keep the real "₹" via `formatPaiseAsInr` directly;
 * only THIS module's PDF text substitutes a plain-ASCII "Rs." prefix, so
 * every money value below still reads correctly without embedding a
 * Unicode-capable font file just for one glyph.
 */
function formatPaiseAsInr(paise: number): string {
  return formatPaiseAsInrWithSymbol(paise).replace("₹", "Rs. ");
}

/**
 * Server-side PDF generation for the Operational Report (Phase 28C).
 *
 * Uses pdfmake's built-in standard Helvetica font (`standard-fonts/
 * Helvetica.js`) - a font-descriptor pointing at PDFKit's own built-in
 * font names ("Helvetica-Bold" etc.), never an embedded TTF file. This
 * means no font files ship with this app and no filesystem/network access
 * is needed to render a PDF at all: `setLocalAccessPolicy` is locked down
 * to allow ONLY those exact standard-font names (pdfmake treats every font
 * reference as a "path" to validate, standard names included), and
 * `setUrlAccessPolicy` denies all remote URLs outright - this report never
 * references an external resource, so both policies fail closed rather
 * than silently trusting whatever a future docDefinition might add.
 *
 * Every figure rendered here comes directly from `ReportData` (already
 * assembled from real, authorized query services) - this module only
 * formats, it never computes or estimates.
 */
const STANDARD_FONT_NAMES = new Set(Object.values(standardFonts.Helvetica));
let policiesConfigured = false;

function configurePdfMake(): void {
  if (policiesConfigured) return;
  pdfMake.setFonts(standardFonts);
  pdfMake.setLocalAccessPolicy((path: string) => STANDARD_FONT_NAMES.has(path));
  pdfMake.setUrlAccessPolicy(() => false);
  policiesConfigured = true;
}

const HEADING = { fontSize: 13, bold: true, margin: [0, 16, 0, 6] as [number, number, number, number] };
const SUBTLE = { fontSize: 9, color: "#6b7280" };

export async function renderReportPdf(report: ReportData): Promise<Buffer> {
  configurePdfMake();

  const periodLine = `Period: ${report.period.since ?? "the beginning"} through ${report.period.until}`;

  const docDefinition = {
    pageMargins: [40, 50, 40, 40] as [number, number, number, number],
    content: [
      { text: "Revenue Recovery Intelligence", fontSize: 18, bold: true },
      { text: "Operational Report", fontSize: 12, color: "#374151", margin: [0, 2, 0, 0] as [number, number, number, number] },
      { text: periodLine, ...SUBTLE, margin: [0, 4, 0, 0] as [number, number, number, number] },
      { text: `Generated ${report.generatedAt}`, ...SUBTLE },

      { text: "1. Executive Summary", style: "heading" },
      {
        table: {
          widths: ["*", "*", "*"],
          body: [
            ["Revenue at risk", "Recovery opportunity", "Recovered"],
            [
              formatPaiseAsInr(report.overview.operational.revenueAtRiskPaise),
              formatPaiseAsInr(report.recoveryOpportunityPaise),
              formatPaiseAsInr(report.overview.attributedOutcomes.naturalRecoveryGmvPaise + report.overview.attributedOutcomes.interventionRecoveryGmvPaise),
            ],
          ],
        },
        layout: "lightHorizontalLines",
      },
      {
        text: incrementalRecoverySentence(report),
        margin: [0, 8, 0, 0] as [number, number, number, number],
      },

      { text: "2. Payment Activity", style: "heading" },
      { text: `${report.paymentActivity.totalCount} payments totaling ${formatPaiseAsInr(report.paymentActivity.totalAmountPaise)}.` },
      {
        table: {
          widths: ["*", "auto", "auto"],
          body: [
            ["Status", "Count", "Amount"],
            ...Object.entries(report.paymentActivity.byStatus).map(([status, v]) => [
              humanizeEnumValue(status),
              String(v?.count ?? 0),
              formatPaiseAsInr(v?.amountPaise ?? 0),
            ]),
          ],
        },
        layout: "lightHorizontalLines",
        margin: [0, 6, 0, 0] as [number, number, number, number],
      },

      { text: "3. Recovery Performance", style: "heading" },
      {
        table: {
          widths: ["*", "auto", "auto"],
          body: [
            ["Attribution", "Count", "Recovered GMV"],
            ["Natural recovery", String(report.overview.attributedOutcomes.naturalRecoveryCount), formatPaiseAsInr(report.overview.attributedOutcomes.naturalRecoveryGmvPaise)],
            ["Intervention recovery", String(report.overview.attributedOutcomes.interventionRecoveryCount), formatPaiseAsInr(report.overview.attributedOutcomes.interventionRecoveryGmvPaise)],
            ["Unknown attribution", String(report.overview.attributedOutcomes.unknownAttributionCount), "-"],
          ],
        },
        layout: "lightHorizontalLines",
      },
      {
        text: `Observed recovery rate: ${formatPercentOrUnavailable(report.overview.attributedOutcomes.observedRecoveryRate)} (${report.overview.attributedOutcomes.recoveredCount} of ${report.overview.attributedOutcomes.matureOutcomesCount} mature outcomes). Interventions attempted: ${report.overview.operational.interventionsAttempted}, succeeded: ${report.overview.operational.interventionsSucceeded}.`,
        margin: [0, 6, 0, 0] as [number, number, number, number],
      },

      { text: "4. Decision Analysis", style: "heading" },
      {
        table: {
          widths: ["*", "auto"],
          body: [
            ["Decision", "Open candidates"],
            ["Act", String(report.decisionMix.ACT)],
            ["Wait", String(report.decisionMix.WAIT)],
            ["Stop", String(report.decisionMix.STOP)],
            ["Escalate", String(report.decisionMix.ESCALATE)],
          ],
        },
        layout: "lightHorizontalLines",
      },

      { text: "5. Experiment Evidence", style: "heading" },
      ...(report.experiments.length === 0
        ? [{ text: "No experiments configured for this merchant.", ...SUBTLE }]
        : report.experiments.flatMap((experiment) => experimentSection(experiment))),

      { text: "6. Audit / Methodology", style: "heading" },
      { text: "Recent recovery activity (most recent first):", margin: [0, 0, 0, 4] as [number, number, number, number] },
      {
        ul: report.recentActivity.length > 0
          ? report.recentActivity.map((event) => `${humanizeAuditAction(event.action)} - ${event.createdAt}`)
          : ["No activity recorded yet."],
        fontSize: 9,
      },
      {
        text: "Methodology: recovered/incremental figures are computed by the application's Decision Engine, Execution Service, and Outcome Attribution logic; incremental (causal) GMV is reported only when a completed experiment's measurement result is independently validated as a statistically confirmed effect (VALID_EFFECT). Observed differences between treatment and control are never presented as causal on their own. This report contains no projections or forecasts beyond what has already been observed or validated.",
        ...SUBTLE,
        margin: [0, 10, 0, 0] as [number, number, number, number],
      },
    ],
    styles: { heading: HEADING },
    defaultStyle: { font: "Helvetica", fontSize: 10 },
  };

  const pdfDoc = pdfMake.createPdf(docDefinition);
  return pdfDoc.getBuffer();
}

function incrementalRecoverySentence(report: ReportData): string {
  const result = report.overview.incrementalRecovery;
  if (result.status === "available") {
    return `Validated incremental (causal) recovery: ${formatPaiseAsInr(result.estimatedIncrementalGMVPaise)}, against an estimated counterfactual of ${formatPaiseAsInr(result.estimatedCounterfactualTreatmentGMVPaise)}.`;
  }
  const REASON_COPY: Record<typeof result.reason, string> = {
    no_experiment_configured: "No experiment has been configured for this merchant yet - no incremental (causal) figure is available.",
    no_valid_effect_result: "No experiment has produced a statistically validated effect yet - no incremental (causal) figure is available.",
    ambiguous_multiple_valid_effect_experiments: "Multiple experiments show a validated effect; which one represents merchant-wide incremental recovery is not yet defined, so no single figure is reported.",
  };
  return REASON_COPY[result.reason];
}

function experimentSection(experiment: ReportData["experiments"][number]) {
  const result = experiment.latestResult;
  const rows = [
    { text: experiment.name, bold: true, margin: [0, 8, 0, 2] as [number, number, number, number] },
    { text: `Status: ${humanizeEnumValue(experiment.status)} - Version ${experiment.version}`, ...SUBTLE },
  ];
  if (!result) {
    return [...rows, { text: "No measurement result computed yet.", ...SUBTLE }];
  }
  const observed = result.observedDifference
    ? `Observed difference: ${(result.observedDifference.observedDifference * 100).toFixed(1)} pts (95% CI ${(result.observedDifference.lower * 100).toFixed(1)} to ${(result.observedDifference.upper * 100).toFixed(1)}) - observed, not causal.`
    : "Observed difference: not available.";
  const incremental =
    result.incrementalEstimate.status === "available"
      ? `Incremental (causal) recovered GMV: ${formatPaiseAsInr(result.incrementalEstimate.estimatedIncrementalGMVPaise)} vs. estimated counterfactual ${formatPaiseAsInr(result.incrementalEstimate.estimatedCounterfactualTreatmentGMVPaise)}.`
      : "Incremental (causal) estimate: not available - result did not meet the validated-effect threshold.";
  return [
    ...rows,
    {
      table: {
        widths: ["*", "auto", "auto"],
        body: [
          ["Arm", "Analyzable / Successes", "Rate"],
          ["Treatment", `${result.treatment.analyzableUnits} / ${result.treatment.successUnits}`, formatPercentOrUnavailable(result.treatment.rate)],
          ["Control", `${result.control.analyzableUnits} / ${result.control.successUnits}`, formatPercentOrUnavailable(result.control.rate)],
        ],
      },
      layout: "lightHorizontalLines",
      margin: [0, 2, 0, 4] as [number, number, number, number],
    },
    { text: observed, fontSize: 9 },
    { text: incremental, fontSize: 9, margin: [0, 2, 0, 0] as [number, number, number, number] },
  ];
}
