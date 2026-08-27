import type { Experiment, ExperimentMeasurementResult, ExperimentStatus, MeasurementResultKind, MeasurementResultStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * The Experiment + Measurement Result read query service (Phase 25 Step 6).
 *
 * A read-only projection over EXISTING domain tables (Experiment,
 * ExperimentMeasurementResult) - contains NO assignment logic, NO
 * eligibility/validity/statistical computation, and NEVER calls
 * assignmentEngine.ts/experimentResultService.ts/statistics.ts. It only
 * shapes already-persisted rows into stable, sanitized response DTOs.
 *
 * Merchant scoping happens IN each query's WHERE clause (`merchantId`
 * directly on Experiment, `experiment: { merchantId }` through the relation
 * for ExperimentMeasurementResult) - never fetch-then-filter-in-app-code.
 * `merchantId` MUST already be the caller's own authorized merchant (same
 * trust contract as recoveryQueueService.ts/decisionDetailService.ts/
 * overviewService.ts) - this module never verifies it itself.
 *
 * There is deliberately NO assignments query here (Phase 25 Step 6 audit,
 * Sections B/F): exposing per-unit ExperimentAssignment rows would surface
 * which individual Customer/RevenueRiskEvent landed in which arm, which has
 * no stated product need and real (if modest) sensitivity. If that need
 * ever arises, it is a separate, explicitly-scoped endpoint.
 *
 * ExperimentMeasurementResult.validityChecks is NEVER exposed wholesale -
 * three of its checks (assignment_uniqueness, treatment_arm_consistency,
 * analysis_unit_integrity - see validity.ts) embed raw Customer.id/
 * RevenueRiskEvent.id/ExperimentAssignment.id values in their `details`.
 * `sanitizeValidityChecks` below allowlists exactly {code, severity, passed,
 * message} and structurally can never copy a `details` field forward,
 * regardless of what the underlying JSON contains.
 *
 * Incremental/counterfactual GMV fields are only ever returned when the
 * persisted `resultStatus` is VALID_EFFECT (Phase 24 Step 4's own
 * composeMeasurementResult already enforces that a bare "treatment >
 * control" or "CI excludes zero" can never alone produce that status) -
 * this module only reads and honors that already-computed status, it never
 * recomputes or second-guesses it.
 */

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const VALID_EXPERIMENT_STATUSES: readonly ExperimentStatus[] = ["DRAFT", "RUNNING", "PAUSED", "COMPLETED"];
const VALID_RESULT_KINDS: readonly MeasurementResultKind[] = ["INTERIM", "FINAL"];

export function isValidExperimentStatus(value: unknown): value is ExperimentStatus {
  return typeof value === "string" && (VALID_EXPERIMENT_STATUSES as readonly string[]).includes(value);
}

export function isValidMeasurementResultKind(value: unknown): value is MeasurementResultKind {
  return typeof value === "string" && (VALID_RESULT_KINDS as readonly string[]).includes(value);
}

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;
const DEFAULT_RESULTS_LIMIT = 25;
const MAX_RESULTS_LIMIT = 100;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export type ExperimentSummaryDTO = {
  id: string;
  name: string;
  status: ExperimentStatus;
  version: string;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
};

export type ValidityCheckDTO = {
  code: string;
  severity: "ERROR" | "WARNING" | "INFO";
  passed: boolean;
  message: string;
};

export type IncrementalEstimateDTO =
  | { status: "unavailable"; reason: "not_valid_effect" }
  | { status: "available"; estimatedIncrementalGMVPaise: number; estimatedCounterfactualTreatmentGMVPaise: number };

export type MeasurementResultDTO = {
  id: string;
  version: number;
  resultKind: MeasurementResultKind;
  resultStatus: MeasurementResultStatus;
  generatedAt: string;
  calculatedAt: string;
  dataCutoffAt: string;
  methodology: {
    statisticalMethodVersion: string;
    eligibilityLogicVersion: string;
    validityLogicVersion: string;
    confidenceLevel: number;
  };
  minimumPracticalEffectRateDifference: number | null;
  totalAssignments: number;
  treatment: {
    analyzableUnits: number;
    successUnits: number;
    rate: number | null;
    rateLower: number | null;
    rateUpper: number | null;
    recoveredGMVPaise: number;
    unknownOnlyUnits: number;
  };
  control: {
    analyzableUnits: number;
    successUnits: number;
    rate: number | null;
    rateLower: number | null;
    rateUpper: number | null;
    recoveredGMVPaise: number;
    unknownOnlyUnits: number;
  };
  /** A raw sample statistic (statistics.ts's OBSERVED_TREATMENT_CONTROL_DIFFERENCE)
   * - explicitly labeled "observed", never itself a causal/incremental claim.
   * Returned regardless of resultStatus. */
  observedDifference: { observedDifference: number; lower: number; upper: number } | null;
  /** Only ever "available" when resultStatus === VALID_EFFECT - see this
   * module's doc comment. */
  incrementalEstimate: IncrementalEstimateDTO;
  exclusions: { totalExcluded: number; reasonCounts: Record<string, number> };
  /** Sanitized - see sanitizeValidityChecks. Never the raw persisted JSON. */
  validity: { checks: ValidityCheckDTO[] };
};

export type ExperimentDetailDTO = ExperimentSummaryDTO & {
  hypothesis: string | null;
  description: string | null;
  trafficAllocationPercent: number;
  treatmentAllocationPercent: number;
  treatmentDefinition: string;
  controlDefinition: string;
  /** The most recently generated ExperimentMeasurementResult row for this
   * experiment (ORDER BY generatedAt DESC), regardless of resultKind - null
   * when no snapshot has ever been persisted. Per the schema's own FINAL
   * doc comment: "the" latest result is always the most recently generated
   * one, never a separate mutable pointer. */
  latestResult: MeasurementResultDTO | null;
};

// ---------------------------------------------------------------------------
// Sanitizers - the actual security boundary for the two JSON columns
// ---------------------------------------------------------------------------

const VALID_SEVERITIES = new Set(["ERROR", "WARNING", "INFO"]);

/**
 * Allowlists exactly {code, severity, passed, message} out of each
 * persisted ValidityCheck. This can NEVER copy a `details` field forward -
 * it is not read here at all - which is what actually prevents the three
 * ID-bearing checks (assignment_uniqueness/treatment_arm_consistency/
 * analysis_unit_integrity) from ever reaching a client, regardless of what
 * the underlying JSON contains or how validity.ts evolves.
 */
export function sanitizeValidityChecks(raw: unknown): ValidityCheckDTO[] {
  if (!Array.isArray(raw)) return [];
  const checks: ValidityCheckDTO[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const code = record.code;
    const severity = record.severity;
    const passed = record.passed;
    const message = record.message;
    if (typeof code !== "string" || typeof passed !== "boolean" || typeof message !== "string") continue;
    if (typeof severity !== "string" || !VALID_SEVERITIES.has(severity)) continue;
    checks.push({ code, severity: severity as ValidityCheckDTO["severity"], passed, message });
  }
  return checks;
}

/**
 * `exclusionReasonCounts` is a closed enum ({reason: count} keyed by
 * eligibility.ts's static NotAnalyzableReason strings) with no identifiers
 * - safe to expose in full (Phase 25 Step 6 audit finding). Still defensively
 * re-typed here rather than passed through raw JSON verbatim, keeping only
 * numeric-valued entries.
 */
export function sanitizeExclusionReasonCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number") result[key] = value;
  }
  return result;
}

/** Only ever "available" when resultStatus is VALID_EFFECT - honors the
 * already-computed status, never recomputes it. Defensively falls back to
 * "unavailable" if the persisted estimate fields are unexpectedly null even
 * under VALID_EFFECT, rather than ever fabricating or exposing a null as a
 * number. */
function mapIncrementalEstimate(row: ExperimentMeasurementResult): IncrementalEstimateDTO {
  if (
    row.resultStatus === "VALID_EFFECT" &&
    row.estimatedIncrementalGMVPaise !== null &&
    row.estimatedCounterfactualTreatmentGMVPaise !== null
  ) {
    return {
      status: "available",
      estimatedIncrementalGMVPaise: row.estimatedIncrementalGMVPaise,
      estimatedCounterfactualTreatmentGMVPaise: row.estimatedCounterfactualTreatmentGMVPaise,
    };
  }
  return { status: "unavailable", reason: "not_valid_effect" };
}

function mapMeasurementResult(row: ExperimentMeasurementResult): MeasurementResultDTO {
  const observedDifference =
    row.observedDifference !== null && row.observedDifferenceLower !== null && row.observedDifferenceUpper !== null
      ? { observedDifference: row.observedDifference, lower: row.observedDifferenceLower, upper: row.observedDifferenceUpper }
      : null;

  return {
    id: row.id,
    version: row.version,
    resultKind: row.resultKind,
    resultStatus: row.resultStatus,
    generatedAt: row.generatedAt.toISOString(),
    calculatedAt: row.calculatedAt.toISOString(),
    dataCutoffAt: row.dataCutoffAt.toISOString(),
    methodology: {
      statisticalMethodVersion: row.statisticalMethodVersion,
      eligibilityLogicVersion: row.eligibilityLogicVersion,
      validityLogicVersion: row.validityLogicVersion,
      confidenceLevel: row.confidenceLevel,
    },
    minimumPracticalEffectRateDifference: row.minimumPracticalEffectRateDifference,
    totalAssignments: row.totalAssignments,
    treatment: {
      analyzableUnits: row.treatmentAnalyzableUnits,
      successUnits: row.treatmentSuccessUnits,
      rate: row.treatmentRate,
      rateLower: row.treatmentRateLower,
      rateUpper: row.treatmentRateUpper,
      recoveredGMVPaise: row.treatmentRecoveredGMVPaise,
      unknownOnlyUnits: row.treatmentUnknownOnlyUnits,
    },
    control: {
      analyzableUnits: row.controlAnalyzableUnits,
      successUnits: row.controlSuccessUnits,
      rate: row.controlRate,
      rateLower: row.controlRateLower,
      rateUpper: row.controlRateUpper,
      recoveredGMVPaise: row.controlRecoveredGMVPaise,
      unknownOnlyUnits: row.controlUnknownOnlyUnits,
    },
    observedDifference,
    incrementalEstimate: mapIncrementalEstimate(row),
    exclusions: {
      totalExcluded: row.excludedUnitsTotal,
      reasonCounts: sanitizeExclusionReasonCounts(row.exclusionReasonCounts),
    },
    validity: { checks: sanitizeValidityChecks(row.validityChecks) },
  };
}

function mapExperimentSummary(experiment: Experiment): ExperimentSummaryDTO {
  return {
    id: experiment.id,
    name: experiment.name,
    status: experiment.status,
    version: experiment.version,
    startedAt: experiment.startedAt?.toISOString() ?? null,
    endedAt: experiment.endedAt?.toISOString() ?? null,
    createdAt: experiment.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export type ExperimentListQuery = { status?: ExperimentStatus; cursor?: string; limit?: number };
export type ExperimentListResult = { items: ExperimentSummaryDTO[]; nextCursor: string | null };

/** Lists this merchant's experiments, cursor-paginated. `merchantId` MUST
 * already be the caller's own authorized merchant. */
export async function listExperiments(merchantId: string, query: ExperimentListQuery): Promise<ExperimentListResult> {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const rows = await prisma.experiment.findMany({
    where: { merchantId, ...(query.status ? { status: query.status } : {}) },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  return {
    items: pageRows.map(mapExperimentSummary),
    nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null,
  };
}

export type ExperimentDetailOutcome = { status: "found"; experiment: ExperimentDetailDTO } | { status: "not_found" };

/**
 * Fetches one experiment's detail plus its latest measurement result,
 * scoped to `merchantId`. A foreign-merchant `experimentId` and a
 * nonexistent one both return `{status: "not_found"}` - the route maps
 * both to the identical 404, matching Decision Detail's established
 * enumeration-resistance contract (Phase 25 Step 3).
 */
export async function getExperimentDetail(merchantId: string, experimentId: string): Promise<ExperimentDetailOutcome> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, merchantId },
  });
  if (!experiment) {
    return { status: "not_found" };
  }

  // Safe without a redundant merchant filter: `experiment.id` above was
  // already proven to belong to `merchantId` (same pattern as
  // decisionDetailService.ts's separate AuditEvent lookup by entityId).
  const latest = await prisma.experimentMeasurementResult.findFirst({
    where: { experimentId: experiment.id },
    orderBy: { generatedAt: "desc" },
  });

  return {
    status: "found",
    experiment: {
      ...mapExperimentSummary(experiment),
      hypothesis: experiment.hypothesis,
      description: experiment.description,
      trafficAllocationPercent: experiment.trafficAllocationPercent,
      treatmentAllocationPercent: experiment.treatmentAllocationPercent,
      treatmentDefinition: experiment.treatmentDefinition,
      controlDefinition: experiment.controlDefinition,
      latestResult: latest ? mapMeasurementResult(latest) : null,
    },
  };
}

export type ExperimentResultsQuery = { kind?: MeasurementResultKind; cursor?: string; limit?: number };
export type ExperimentResultsOutcome =
  | { status: "found"; items: MeasurementResultDTO[]; nextCursor: string | null }
  | { status: "not_found" };

/**
 * Lists the full measurement-result history for one experiment (all
 * versions, newest generatedAt first), scoped to `merchantId` via the
 * experiment's own merchant. Same not_found/foreign-merchant collapsing as
 * `getExperimentDetail`.
 */
export async function listExperimentResults(
  merchantId: string,
  experimentId: string,
  query: ExperimentResultsQuery
): Promise<ExperimentResultsOutcome> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, merchantId },
    select: { id: true },
  });
  if (!experiment) {
    return { status: "not_found" };
  }

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_RESULTS_LIMIT, 1), MAX_RESULTS_LIMIT);

  const rows = await prisma.experimentMeasurementResult.findMany({
    where: { experimentId: experiment.id, ...(query.kind ? { resultKind: query.kind } : {}) },
    orderBy: [{ generatedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasNextPage = rows.length > limit;
  const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

  return {
    status: "found",
    items: pageRows.map(mapMeasurementResult),
    nextCursor: hasNextPage ? pageRows[pageRows.length - 1].id : null,
  };
}
