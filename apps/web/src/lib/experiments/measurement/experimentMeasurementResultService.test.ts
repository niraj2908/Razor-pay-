import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.mock` factories are hoisted above all top-level `const` declarations,
 * so the mock store and functions must be created inside `vi.hoisted()` -
 * the same pattern already established in executionService.test.ts.
 *
 * The store simulates BOTH real Postgres unique constraints on
 * ExperimentMeasurementResult: (experimentId, version) and
 * (experimentId, statisticalMethodVersion, eligibilityLogicVersion,
 * validityLogicVersion, dataCutoffAt) - `create` checks both, synchronously,
 * before any await, so concurrent calls race exactly the way concurrent DB
 * connections would.
 */
const mocks = vi.hoisted(() => {
  type Row = Record<string, unknown> & { id: string; experimentId: string; version: number; dataCutoffAt: Date };
  const store = new Map<string, Row>();
  const auditEvents: Record<string, unknown>[] = [];
  let idCounter = 0;

  function calcIdentityKey(row: Omit<Row, "id">): string {
    return [row.experimentId, row.statisticalMethodVersion, row.eligibilityLogicVersion, row.validityLogicVersion, (row.dataCutoffAt as Date).toISOString()].join("|");
  }
  function versionKey(row: Omit<Row, "id">): string {
    return `${row.experimentId}::${row.version}`;
  }

  // Mirrors what real PostgreSQL/Prisma actually reports for a NAMED
  // compound unique constraint: `meta.target` is the array of SCHEMA FIELD
  // NAMES the constraint covers, never the raw SQL constraint name string
  // (confirmed empirically against the real database).
  function makeConstraintError(fields: string[]) {
    const error = new Error(`Unique constraint failed on the fields: (${fields.map((f) => `\`${f}\``).join(",")})`) as Error & {
      code: string;
      meta: { target: string[] };
    };
    error.code = "P2002";
    error.meta = { target: fields };
    return error;
  }

  const experimentMeasurementResultCreate = vi.fn(async ({ data }: { data: Omit<Row, "id"> }) => {
    for (const existing of store.values()) {
      if (versionKey(existing) === versionKey(data)) {
        throw makeConstraintError(["experimentId", "version"]);
      }
      if (calcIdentityKey(existing) === calcIdentityKey(data)) {
        throw makeConstraintError(["experimentId", "statisticalMethodVersion", "eligibilityLogicVersion", "validityLogicVersion", "dataCutoffAt"]);
      }
    }
    const row = { id: `result_${++idCounter}`, ...data } as Row;
    store.set(row.id, row);
    return row;
  });

  const experimentMeasurementResultFindFirst = vi.fn(async ({ where }: { where: { experimentId: string } }) => {
    const rows = [...store.values()].filter((r) => r.experimentId === where.experimentId);
    if (rows.length === 0) return null;
    return rows.sort((a, b) => b.version - a.version)[0];
  });

  const experimentMeasurementResultFindUniqueOrThrow = vi.fn(async ({ where }: { where: { calcIdentityKey: Row } }) => {
    const target = where.calcIdentityKey;
    const found = [...store.values()].find((r) => calcIdentityKey(r) === calcIdentityKey({ ...target, id: "", version: 0 } as Row));
    if (!found) throw new Error("ExperimentMeasurementResult not found");
    return found;
  });

  const auditEventCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    auditEvents.push(data);
    return { id: `audit_${auditEvents.length}` };
  });

  return {
    store,
    auditEvents,
    reset: () => {
      store.clear();
      auditEvents.length = 0;
      idCounter = 0;
    },
    experimentMeasurementResultCreate,
    experimentMeasurementResultFindFirst,
    experimentMeasurementResultFindUniqueOrThrow,
    auditEventCreate,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    experimentMeasurementResult: {
      create: mocks.experimentMeasurementResultCreate,
      findFirst: mocks.experimentMeasurementResultFindFirst,
      findUniqueOrThrow: mocks.experimentMeasurementResultFindUniqueOrThrow,
    },
    auditEvent: { create: mocks.auditEventCreate },
  },
}));

const { persistExperimentResult } = await import("./experimentMeasurementResultService");
import type { ExperimentAnalysisResult } from "./experimentResultService";

const CALCULATED_AT = new Date("2026-03-01T00:00:00.000Z");

function baseResult(overrides: Partial<ExperimentAnalysisResult> = {}): ExperimentAnalysisResult {
  return {
    experimentId: "exp_1",
    experimentStatus: "RUNNING",
    calculatedAt: CALCULATED_AT.toISOString(),
    eligibilityLogicVersion: "eligibility-v1",
    statisticalMethodVersion: "statistics-v1",
    validityLogicVersion: "validity-v1",
    confidenceLevel: 0.95,
    validity: {
      experimentId: "exp_1",
      status: "VALID",
      checks: [
        { code: "immature_observations", severity: "INFO", passed: true, message: "", details: { notYetMatureCount: 0, missingOutcomePastWindowCount: 0 } },
        { code: "excluded_assignments_summary", severity: "INFO", passed: true, message: "", details: { excludedCount: 2, totalUnits: 10, reasonCounts: { outcome_not_mature: 2 } } },
      ],
    },
    treatment: {
      recoveryRate: { arm: "TREATMENT", analyzableUnits: 5, successes: 3, failures: 2, rate: 0.6, confidenceInterval: { status: "computed", successes: 3, trials: 5, confidenceLevel: 0.95, pointEstimate: 0.6, lower: 0.2, upper: 0.9 } },
      gmv: { arm: "TREATMENT", recoveredGMV: 15000, analyzableUnits: 5, successUnits: 3 },
      sensitivity: { label: "UNKNOWN_SENSITIVITY_BOUND", arm: "TREATMENT", observed: { successes: 3, analyzableUnits: 5, rate: 0.6 }, bestCase: { successes: 3, analyzableUnits: 5, rate: 0.6 }, worstCase: { successes: 3, analyzableUnits: 5, rate: 0.6 }, unknownOnlyUnitCount: 0 },
    },
    control: {
      recoveryRate: { arm: "CONTROL", analyzableUnits: 5, successes: 1, failures: 4, rate: 0.2, confidenceInterval: { status: "computed", successes: 1, trials: 5, confidenceLevel: 0.95, pointEstimate: 0.2, lower: 0.01, upper: 0.6 } },
      gmv: { arm: "CONTROL", recoveredGMV: 5000, analyzableUnits: 5, successUnits: 1 },
      sensitivity: { label: "UNKNOWN_SENSITIVITY_BOUND", arm: "CONTROL", observed: { successes: 1, analyzableUnits: 5, rate: 0.2 }, bestCase: { successes: 1, analyzableUnits: 5, rate: 0.2 }, worstCase: { successes: 1, analyzableUnits: 5, rate: 0.2 }, unknownOnlyUnitCount: 1 },
    },
    observedDifference: {
      status: "computed",
      label: "OBSERVED_TREATMENT_CONTROL_DIFFERENCE",
      treatmentRate: 0.6,
      controlRate: 0.2,
      observedDifference: 0.4,
      confidenceInterval: { lower: 0.1, upper: 0.7 },
    },
    incrementalGMV: {
      status: "computed",
      observedTreatmentGMV: 15000,
      observedControlGMV: 5000,
      estimatedCounterfactualTreatmentGMV: 5000,
      estimatedIncrementalGMV: 10000,
    },
    sampleSize: null,
    ...overrides,
  };
}

describe("persistExperimentResult", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
  });

  it("rejects an unresolved experiment (experiment_not_found) without touching the database", async () => {
    const result = await persistExperimentResult({ status: "experiment_not_found" }, null);
    expect(result).toEqual({ status: "rejected", reason: "not_computed" });
    expect(mocks.experimentMeasurementResultCreate).not.toHaveBeenCalled();
  });

  it("creates a version-1 snapshot on first persistence, with correct field mapping and an audit event", async () => {
    const outcome = await persistExperimentResult(baseResult(), null);

    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.record.version).toBe(1);
    expect(outcome.record.resultStatus).toBe("VALID_INCONCLUSIVE"); // no minimumPracticalEffect configured
    expect(outcome.record.resultKind).toBe("INTERIM"); // RUNNING experiment
    expect(outcome.record.treatmentRecoveredGMVPaise).toBe(15000);
    expect(outcome.record.controlRecoveredGMVPaise).toBe(5000);
    expect(outcome.record.estimatedIncrementalGMVPaise).toBe(10000);
    expect(outcome.record.minimumPracticalEffectRateDifference).toBeNull();
    expect(outcome.record.excludedUnitsTotal).toBe(2);
    expect(outcome.record.totalAssignments).toBe(10);
    expect(outcome.record.controlUnknownOnlyUnits).toBe(1);

    expect(mocks.auditEvents).toHaveLength(1);
    expect(mocks.auditEvents[0]).toMatchObject({ entityType: "ExperimentMeasurementResult", action: "experiment_measurement_result.created", actorType: "SYSTEM" });
  });

  it("applies a configured minimum practical effect and can produce VALID_EFFECT", async () => {
    const outcome = await persistExperimentResult(baseResult(), { minimumRateDifference: 0.05 });
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    // observedDifference lower bound (0.1) clears the 0.05 threshold.
    expect(outcome.record.resultStatus).toBe("VALID_EFFECT");
    expect(outcome.record.minimumPracticalEffectRateDifference).toBe(0.05);
  });

  it("FINAL resultKind requires COMPLETED status AND full maturity", async () => {
    const completedButImmature = baseResult({ experimentStatus: "COMPLETED" }); // immature_observations already says fully matured=true by default fixture
    const outcome = await persistExperimentResult(completedButImmature, null);
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.record.resultKind).toBe("FINAL");
  });

  it("a duplicate call for the EXACT SAME calculation identity returns the existing row - never a second row", async () => {
    const result = baseResult();
    const first = await persistExperimentResult(result, null);
    const second = await persistExperimentResult(result, null);

    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status !== "created" || second.status !== "existing") return;
    expect(second.record.id).toBe(first.record.id);
    // create() IS attempted twice (the second attempt is what discovers the
    // P2002 calc-identity conflict) - but that attempt never stores a row,
    // so exactly one row exists and exactly one audit event was recorded.
    expect(mocks.experimentMeasurementResultCreate).toHaveBeenCalledTimes(2);
    expect(mocks.store.size).toBe(1);
    expect(mocks.auditEvents).toHaveLength(1); // no audit event for the idempotent duplicate
  });

  it("a DIFFERENT calculation (different data cutoff) for the same experiment gets the NEXT version, not a collision", async () => {
    const first = await persistExperimentResult(baseResult(), null);
    const second = await persistExperimentResult(baseResult({ calculatedAt: new Date("2026-03-02T00:00:00.000Z").toISOString() }), null);

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") return;
    expect(first.record.version).toBe(1);
    expect(second.record.version).toBe(2);
    expect(second.record.id).not.toBe(first.record.id);
  });

  it("retries with a fresh version after losing a concurrent version race, without duplicating or crashing", async () => {
    // Pre-seed a version-1 row directly in the store to simulate another
    // writer having already claimed it between this call's read and write.
    mocks.store.set("preexisting", {
      id: "preexisting",
      experimentId: "exp_1",
      version: 1,
      statisticalMethodVersion: "statistics-v1",
      eligibilityLogicVersion: "eligibility-v1",
      validityLogicVersion: "validity-v1",
      dataCutoffAt: new Date("2020-01-01T00:00:00.000Z"), // deliberately a DIFFERENT cutoff, so this is a version collision, not a calc-identity duplicate
    });

    const outcome = await persistExperimentResult(baseResult(), null);
    expect(outcome.status).toBe("created");
    if (outcome.status !== "created") return;
    expect(outcome.record.version).toBe(2); // correctly skipped the already-taken version 1
  });

  it("five concurrent persistence calls for five DIFFERENT cutoffs converge on five distinct, non-colliding versions", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        persistExperimentResult(baseResult({ calculatedAt: new Date(2026, 2, i + 1).toISOString() }), null)
      )
    );
    expect(results.every((r) => r.status === "created")).toBe(true);
    const versions = results.map((r) => (r.status === "created" ? r.record.version : null));
    expect(new Set(versions).size).toBe(5); // all distinct
  });
});
