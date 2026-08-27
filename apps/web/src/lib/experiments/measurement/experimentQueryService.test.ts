import { beforeEach, describe, expect, it, vi } from "vitest";

const experimentFindMany = vi.fn();
const experimentFindFirst = vi.fn();
const measurementResultFindFirst = vi.fn();
const measurementResultFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    experiment: { findMany: experimentFindMany, findFirst: experimentFindFirst },
    experimentMeasurementResult: { findFirst: measurementResultFindFirst, findMany: measurementResultFindMany },
  },
}));

const {
  isValidExperimentStatus,
  isValidMeasurementResultKind,
  sanitizeValidityChecks,
  sanitizeExclusionReasonCounts,
  listExperiments,
  getExperimentDetail,
  listExperimentResults,
} = await import("./experimentQueryService");

function baseExperiment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "clexperiment0001",
    merchantId: "merchant_a",
    name: "Retry copy test",
    version: "v1",
    hypothesis: "Friendlier copy recovers more",
    description: "A/B test on retry link copy",
    status: "RUNNING",
    trafficAllocationPercent: 100,
    treatmentAllocationPercent: 50,
    treatmentDefinition: "policy-v1",
    controlDefinition: "no_intervention",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endedAt: null,
    createdAt: new Date("2025-12-01T00:00:00.000Z"),
    updatedAt: new Date("2025-12-01T00:00:00.000Z"),
    ...overrides,
  };
}

function baseMeasurementResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "clresult0001",
    experimentId: "clexperiment0001",
    version: 1,
    resultKind: "FINAL",
    resultStatus: "VALID_EFFECT",
    generatedAt: new Date("2026-02-01T00:00:00.000Z"),
    calculatedAt: new Date("2026-02-01T00:00:00.000Z"),
    dataCutoffAt: new Date("2026-02-01T00:00:00.000Z"),
    statisticalMethodVersion: "statistics-v1",
    eligibilityLogicVersion: "eligibility-v1",
    validityLogicVersion: "validity-v1",
    confidenceLevel: 0.95,
    minimumPracticalEffectRateDifference: 0.02,
    totalAssignments: 200,
    treatmentAnalyzableUnits: 100,
    treatmentSuccessUnits: 40,
    treatmentRate: 0.4,
    treatmentRateLower: 0.3,
    treatmentRateUpper: 0.5,
    treatmentRecoveredGMVPaise: 400000,
    controlAnalyzableUnits: 100,
    controlSuccessUnits: 20,
    controlRate: 0.2,
    controlRateLower: 0.12,
    controlRateUpper: 0.28,
    controlRecoveredGMVPaise: 200000,
    observedDifference: 0.2,
    observedDifferenceLower: 0.05,
    observedDifferenceUpper: 0.35,
    estimatedCounterfactualTreatmentGMVPaise: 200000,
    estimatedIncrementalGMVPaise: 200000,
    treatmentUnknownOnlyUnits: 0,
    controlUnknownOnlyUnits: 0,
    excludedUnitsTotal: 5,
    exclusionReasonCounts: { missing_outcome_past_window: 5 },
    validityChecks: [
      { code: "treatment_arm_exists", severity: "WARNING", passed: true, message: "100 TREATMENT unit(s) found." },
    ],
    ...overrides,
  };
}

describe("experimentQueryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("validators", () => {
    it("isValidExperimentStatus accepts only real ExperimentStatus values", () => {
      expect(isValidExperimentStatus("RUNNING")).toBe(true);
      expect(isValidExperimentStatus("DRAFT")).toBe(true);
      expect(isValidExperimentStatus("bogus")).toBe(false);
      expect(isValidExperimentStatus(null)).toBe(false);
    });

    it("isValidMeasurementResultKind accepts only INTERIM/FINAL", () => {
      expect(isValidMeasurementResultKind("INTERIM")).toBe(true);
      expect(isValidMeasurementResultKind("FINAL")).toBe(true);
      expect(isValidMeasurementResultKind("bogus")).toBe(false);
    });
  });

  describe("sanitizeValidityChecks - the exposure security boundary", () => {
    it("keeps only {code, severity, passed, message} and drops details entirely", () => {
      const raw = [
        {
          code: "assignment_uniqueness",
          severity: "ERROR",
          passed: false,
          message: "Duplicate assignment detected.",
          details: { duplicateUnitKeys: ["cust_real_customer_id_123", "rre_real_risk_event_456"] },
        },
      ];
      const result = sanitizeValidityChecks(raw);
      expect(result).toEqual([
        { code: "assignment_uniqueness", severity: "ERROR", passed: false, message: "Duplicate assignment detected." },
      ]);
      expect(JSON.stringify(result)).not.toContain("cust_real_customer_id_123");
      expect(JSON.stringify(result)).not.toContain("rre_real_risk_event_456");
      expect(Object.keys(result[0])).toEqual(["code", "severity", "passed", "message"]);
    });

    it("strips duplicateAssignmentIds/affectedUnitKeys from the other two ID-bearing checks", () => {
      const raw = [
        { code: "treatment_arm_consistency", severity: "ERROR", passed: false, message: "x", details: { affectedUnitKeys: ["rre_1"] } },
        { code: "analysis_unit_integrity", severity: "ERROR", passed: false, message: "y", details: { duplicateAssignmentIds: ["asg_1"] } },
      ];
      const result = sanitizeValidityChecks(raw);
      expect(JSON.stringify(result)).not.toContain("rre_1");
      expect(JSON.stringify(result)).not.toContain("asg_1");
    });

    it("drops malformed entries instead of throwing", () => {
      expect(sanitizeValidityChecks(null)).toEqual([]);
      expect(sanitizeValidityChecks("not an array")).toEqual([]);
      expect(sanitizeValidityChecks([{ code: 123, severity: "ERROR", passed: true, message: "x" }])).toEqual([]);
      expect(sanitizeValidityChecks([{ code: "ok", severity: "NOT_REAL", passed: true, message: "x" }])).toEqual([]);
    });
  });

  describe("sanitizeExclusionReasonCounts", () => {
    it("passes through numeric-valued entries", () => {
      expect(sanitizeExclusionReasonCounts({ outcome_not_mature: 3, unresolved_attribution: 1 })).toEqual({
        outcome_not_mature: 3,
        unresolved_attribution: 1,
      });
    });

    it("drops non-numeric entries and handles non-object input defensively", () => {
      expect(sanitizeExclusionReasonCounts({ a: "not a number" })).toEqual({});
      expect(sanitizeExclusionReasonCounts(null)).toEqual({});
      expect(sanitizeExclusionReasonCounts([1, 2, 3])).toEqual({});
    });
  });

  describe("listExperiments", () => {
    it("scopes the query to merchantId and maps summary fields", async () => {
      experimentFindMany.mockResolvedValue([baseExperiment()]);
      const result = await listExperiments("merchant_a", {});
      expect(experimentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { merchantId: "merchant_a" } })
      );
      expect(result.items).toEqual([
        {
          id: "clexperiment0001",
          name: "Retry copy test",
          status: "RUNNING",
          version: "v1",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: null,
          createdAt: "2025-12-01T00:00:00.000Z",
        },
      ]);
      // Never exposes merchantId, hypothesis, description, or allocation fields at list grain
      expect(Object.keys(result.items[0])).toEqual(["id", "name", "status", "version", "startedAt", "endedAt", "createdAt"]);
    });

    it("applies the status filter when provided", async () => {
      experimentFindMany.mockResolvedValue([]);
      await listExperiments("merchant_a", { status: "COMPLETED" });
      expect(experimentFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { merchantId: "merchant_a", status: "COMPLETED" } })
      );
    });

    it("detects a next page via the limit+1 probe row and never leaks the probe row itself", async () => {
      experimentFindMany.mockResolvedValue([baseExperiment({ id: "a" }), baseExperiment({ id: "b" })]);
      const result = await listExperiments("merchant_a", { limit: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBe("a");
    });

    it("returns nextCursor: null when there is no further page", async () => {
      experimentFindMany.mockResolvedValue([baseExperiment({ id: "a" })]);
      const result = await listExperiments("merchant_a", { limit: 25 });
      expect(result.nextCursor).toBeNull();
    });
  });

  describe("getExperimentDetail - merchant isolation", () => {
    it("scopes the lookup to (id, merchantId) in a single WHERE clause", async () => {
      experimentFindFirst.mockResolvedValue(null);
      await getExperimentDetail("merchant_a", "clexperiment0001");
      expect(experimentFindFirst).toHaveBeenCalledWith({ where: { id: "clexperiment0001", merchantId: "merchant_a" } });
    });

    it("returns not_found (never throws, never a different shape) when the experiment belongs to another merchant", async () => {
      experimentFindFirst.mockResolvedValue(null); // a real Prisma findFirst returns null identically for foreign-merchant or nonexistent
      const result = await getExperimentDetail("merchant_a", "belongs_to_merchant_b");
      expect(result).toEqual({ status: "not_found" });
      expect(measurementResultFindFirst).not.toHaveBeenCalled();
    });

    it("returns latestResult: null when no measurement result has ever been persisted", async () => {
      experimentFindFirst.mockResolvedValue(baseExperiment());
      measurementResultFindFirst.mockResolvedValue(null);
      const result = await getExperimentDetail("merchant_a", "clexperiment0001");
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult).toBeNull();
      }
    });

    it("orders latest-result selection by generatedAt desc", async () => {
      experimentFindFirst.mockResolvedValue(baseExperiment());
      measurementResultFindFirst.mockResolvedValue(baseMeasurementResult());
      await getExperimentDetail("merchant_a", "clexperiment0001");
      expect(measurementResultFindFirst).toHaveBeenCalledWith({
        where: { experimentId: "clexperiment0001" },
        orderBy: { generatedAt: "desc" },
      });
    });

    it("never exposes merchantId on the detail DTO", async () => {
      experimentFindFirst.mockResolvedValue(baseExperiment());
      measurementResultFindFirst.mockResolvedValue(null);
      const result = await getExperimentDetail("merchant_a", "clexperiment0001");
      if (result.status === "found") {
        expect(result.experiment).not.toHaveProperty("merchantId");
      }
    });
  });

  describe("measurement-result causal/incremental safety (via getExperimentDetail's latestResult)", () => {
    async function detailWith(row: ReturnType<typeof baseMeasurementResult>) {
      experimentFindFirst.mockResolvedValue(baseExperiment());
      measurementResultFindFirst.mockResolvedValue(row);
      const result = await getExperimentDetail("merchant_a", "clexperiment0001");
      if (result.status !== "found") throw new Error("expected found");
      return result.experiment.latestResult!;
    }

    it("VALID_EFFECT: incrementalEstimate is available with the persisted paise values", async () => {
      const latest = await detailWith(baseMeasurementResult({ resultStatus: "VALID_EFFECT" }));
      expect(latest.incrementalEstimate).toEqual({
        status: "available",
        estimatedIncrementalGMVPaise: 200000,
        estimatedCounterfactualTreatmentGMVPaise: 200000,
      });
      expect(latest.observedDifference).toEqual({ observedDifference: 0.2, lower: 0.05, upper: 0.35 });
    });

    it("VALID_INCONCLUSIVE: an observed difference can still be present, but incrementalEstimate is unavailable", async () => {
      const latest = await detailWith(
        baseMeasurementResult({
          resultStatus: "VALID_INCONCLUSIVE",
          observedDifference: 0.05,
          observedDifferenceLower: -0.01,
          observedDifferenceUpper: 0.11,
          estimatedIncrementalGMVPaise: null,
          estimatedCounterfactualTreatmentGMVPaise: null,
        })
      );
      expect(latest.observedDifference).toEqual({ observedDifference: 0.05, lower: -0.01, upper: 0.11 });
      expect(latest.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
    });

    it("INVALID: incrementalEstimate is unavailable", async () => {
      const latest = await detailWith(
        baseMeasurementResult({
          resultStatus: "INVALID",
          estimatedIncrementalGMVPaise: null,
          estimatedCounterfactualTreatmentGMVPaise: null,
        })
      );
      expect(latest.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
    });

    it("INSUFFICIENT_DATA: incrementalEstimate is unavailable and observedDifference may be null", async () => {
      const latest = await detailWith(
        baseMeasurementResult({
          resultStatus: "INSUFFICIENT_DATA",
          observedDifference: null,
          observedDifferenceLower: null,
          observedDifferenceUpper: null,
          estimatedIncrementalGMVPaise: null,
          estimatedCounterfactualTreatmentGMVPaise: null,
        })
      );
      expect(latest.observedDifference).toBeNull();
      expect(latest.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
    });

    it("defensively treats VALID_EFFECT with a null persisted estimate as unavailable rather than exposing null", async () => {
      const latest = await detailWith(
        baseMeasurementResult({ resultStatus: "VALID_EFFECT", estimatedIncrementalGMVPaise: null })
      );
      expect(latest.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
    });

    it("preserves monetary values as integers in paise, never converting to rupees", async () => {
      const latest = await detailWith(baseMeasurementResult());
      expect(Number.isInteger(latest.treatment.recoveredGMVPaise)).toBe(true);
      expect(latest.treatment.recoveredGMVPaise).toBe(400000);
      expect(latest.control.recoveredGMVPaise).toBe(200000);
    });

    it("sanitizes validityChecks and exposes exclusionReasonCounts in full on the mapped DTO", async () => {
      const latest = await detailWith(
        baseMeasurementResult({
          validityChecks: [
            {
              code: "assignment_uniqueness",
              severity: "ERROR",
              passed: false,
              message: "dup",
              details: { duplicateUnitKeys: ["cust_secret_id"] },
            },
          ],
          exclusionReasonCounts: { outcome_not_mature: 2 },
        })
      );
      expect(latest.validity.checks).toEqual([{ code: "assignment_uniqueness", severity: "ERROR", passed: false, message: "dup" }]);
      expect(JSON.stringify(latest)).not.toContain("cust_secret_id");
      expect(latest.exclusions.reasonCounts).toEqual({ outcome_not_mature: 2 });
    });
  });

  describe("listExperimentResults", () => {
    it("returns not_found when the experiment does not resolve for this merchant, without ever querying measurement results", async () => {
      experimentFindFirst.mockResolvedValue(null);
      const result = await listExperimentResults("merchant_a", "belongs_to_merchant_b", {});
      expect(result).toEqual({ status: "not_found" });
      expect(measurementResultFindMany).not.toHaveBeenCalled();
    });

    it("scopes the experiment lookup to (id, merchantId)", async () => {
      experimentFindFirst.mockResolvedValue(null);
      await listExperimentResults("merchant_a", "clexperiment0001", {});
      expect(experimentFindFirst).toHaveBeenCalledWith({
        where: { id: "clexperiment0001", merchantId: "merchant_a" },
        select: { id: true },
      });
    });

    it("orders history newest-generatedAt-first and applies the kind filter", async () => {
      experimentFindFirst.mockResolvedValue({ id: "clexperiment0001" });
      measurementResultFindMany.mockResolvedValue([]);
      await listExperimentResults("merchant_a", "clexperiment0001", { kind: "FINAL" });
      expect(measurementResultFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { experimentId: "clexperiment0001", resultKind: "FINAL" },
          orderBy: [{ generatedAt: "desc" }, { id: "asc" }],
        })
      );
    });

    it("paginates history via the limit+1 probe row", async () => {
      experimentFindFirst.mockResolvedValue({ id: "clexperiment0001" });
      measurementResultFindMany.mockResolvedValue([
        baseMeasurementResult({ id: "r2", version: 2 }),
        baseMeasurementResult({ id: "r1", version: 1 }),
      ]);
      const result = await listExperimentResults("merchant_a", "clexperiment0001", { limit: 1 });
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items).toHaveLength(1);
        expect(result.nextCursor).toBe("r2");
      }
    });
  });
});
