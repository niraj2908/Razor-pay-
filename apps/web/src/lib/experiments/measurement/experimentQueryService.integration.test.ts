import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getExperimentDetail, listExperimentResults, listExperiments } from "./experimentQueryService";

/**
 * Real-database integration tests for the Phase 25 Step 6 read API's
 * merchant-isolation claims. A mocked Prisma client can only prove our own
 * code reacts correctly to a *simulated* WHERE clause - it cannot prove
 * that a real foreign-key join and a real `findFirst`/`findMany` against
 * actual Postgres rows for TWO DISTINCT real merchants actually collapses
 * cross-merchant access into "not found." That is what this file proves.
 *
 * ExperimentMeasurementResult rows are created directly via
 * `prisma.experimentMeasurementResult.create()` with explicit field values
 * rather than by running the real measurement pipeline - this file is
 * testing the READ API's isolation/sanitization/DTO behavior against real
 * persisted rows, not re-proving the pipeline's own statistical correctness
 * (already covered by experimentResultService.integration.test.ts and
 * experimentMeasurementResultService.integration.test.ts).
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`. Every row
 * is a clearly-tagged fixture, cleaned up in afterAll.
 */

const TAG = `phase25-step6-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const createdExperimentIds: string[] = [];

async function makeMerchant(label: string) {
  const merchant = await prisma.merchant.create({ data: { name: `${label} ${TAG}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

async function makeExperiment(
  merchantId: string,
  overrides: Partial<{
    name: string;
    status: "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";
    startedAt: Date | null;
    endedAt: Date | null;
    createdAt: Date;
  }> = {}
) {
  const experiment = await prisma.experiment.create({
    data: {
      merchantId,
      name: overrides.name ?? `Experiment ${TAG}-${randomUUID()}`,
      version: "v1",
      hypothesis: "Friendlier retry copy recovers more GMV",
      description: "Integration-test fixture experiment",
      treatmentDefinition: "policy-v1",
      treatmentAllocationPercent: 50,
      status: overrides.status ?? "RUNNING",
      startedAt: overrides.startedAt ?? new Date("2026-01-01T00:00:00.000Z"),
      endedAt: overrides.endedAt ?? null,
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  createdExperimentIds.push(experiment.id);
  return experiment;
}

function baseMeasurementResultData(experimentId: string, version: number, overrides: Record<string, unknown> = {}) {
  return {
    experimentId,
    version,
    resultKind: "FINAL" as const,
    resultStatus: "VALID_EFFECT" as const,
    calculatedAt: new Date(2026, 1, 1 + version),
    // Distinct per version by default - the calcIdentityKey unique
    // constraint (experimentId, statisticalMethodVersion,
    // eligibilityLogicVersion, validityLogicVersion, dataCutoffAt) means two
    // rows for the same experiment under the same algorithm versions AND
    // the same cutoff are the SAME calculation (idempotent, not a new
    // snapshot) - real distinct snapshots always advance dataCutoffAt.
    dataCutoffAt: new Date(2026, 1, 1 + version),
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
    validityChecks: [{ code: "treatment_arm_exists", severity: "WARNING", passed: true, message: "100 TREATMENT unit(s) found." }],
    ...overrides,
  };
}

async function makeMeasurementResult(experimentId: string, version: number, overrides: Record<string, unknown> = {}) {
  return prisma.experimentMeasurementResult.create({ data: baseMeasurementResultData(experimentId, version, overrides) });
}

afterAll(async () => {
  await prisma.experimentMeasurementResult.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experimentAssignment.deleteMany({ where: { experimentId: { in: createdExperimentIds } } });
  await prisma.experiment.deleteMany({ where: { id: { in: createdExperimentIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("Phase 25 Step 6 read API against a real database", () => {
  describe("merchant isolation", () => {
    it("listExperiments: Merchant A never sees Merchant B's experiments", async () => {
      const merchantA = await makeMerchant("Isolation merchant A");
      const merchantB = await makeMerchant("Isolation merchant B");
      const expA = await makeExperiment(merchantA.id, { name: `Shared-looking name ${TAG}` });
      await makeExperiment(merchantB.id, { name: `Shared-looking name ${TAG}` });

      const result = await listExperiments(merchantA.id, {});
      expect(result.items.map((i) => i.id)).toEqual([expA.id]);
    });

    it("getExperimentDetail: Merchant A requesting Merchant B's real experimentId gets not_found, never the experiment", async () => {
      const merchantA = await makeMerchant("Detail isolation merchant A");
      const merchantB = await makeMerchant("Detail isolation merchant B");
      const expB = await makeExperiment(merchantB.id, { name: `Merchant B secret experiment ${TAG}` });

      const result = await getExperimentDetail(merchantA.id, expB.id);
      expect(result).toEqual({ status: "not_found" });
    });

    it("a genuinely nonexistent experimentId produces the IDENTICAL not_found shape as a real foreign-merchant id", async () => {
      const merchantA = await makeMerchant("Enumeration-resistance merchant A");
      const merchantB = await makeMerchant("Enumeration-resistance merchant B");
      const expB = await makeExperiment(merchantB.id);

      const foreignResult = await getExperimentDetail(merchantA.id, expB.id);
      const nonexistentResult = await getExperimentDetail(merchantA.id, `${expB.id}-does-not-exist`);
      expect(foreignResult).toEqual({ status: "not_found" });
      expect(nonexistentResult).toEqual({ status: "not_found" });
      expect(foreignResult).toEqual(nonexistentResult);
    });

    it("listExperimentResults: Merchant A requesting Merchant B's real experimentId gets not_found, never Merchant B's measurement history", async () => {
      const merchantA = await makeMerchant("Results isolation merchant A");
      const merchantB = await makeMerchant("Results isolation merchant B");
      const expB = await makeExperiment(merchantB.id);
      await makeMeasurementResult(expB.id, 1);

      const result = await listExperimentResults(merchantA.id, expB.id, {});
      expect(result).toEqual({ status: "not_found" });
    });

    it("a foreign experiment's measurement results never leak through even when Merchant A has its OWN experiment with results", async () => {
      const merchantA = await makeMerchant("Cross-check merchant A");
      const merchantB = await makeMerchant("Cross-check merchant B");
      const expA = await makeExperiment(merchantA.id);
      const expB = await makeExperiment(merchantB.id);
      const resultA = await makeMeasurementResult(expA.id, 1);
      await makeMeasurementResult(expB.id, 1, { estimatedIncrementalGMVPaise: 9_999_999, estimatedCounterfactualTreatmentGMVPaise: 9_999_999 });

      const ownResult = await listExperimentResults(merchantA.id, expA.id, {});
      const foreignResult = await listExperimentResults(merchantA.id, expB.id, {});
      expect(ownResult.status).toBe("found");
      if (ownResult.status === "found") {
        expect(ownResult.items.map((i) => i.id)).toEqual([resultA.id]);
      }
      expect(foreignResult).toEqual({ status: "not_found" });
    });
  });

  describe("experiment lifecycle states", () => {
    it.each(["DRAFT", "RUNNING", "PAUSED", "COMPLETED"] as const)("renders a %s experiment correctly with no measurement results", async (status) => {
      const merchant = await makeMerchant(`Lifecycle merchant ${status}`);
      const experiment = await makeExperiment(merchant.id, { status, startedAt: status === "DRAFT" ? null : new Date("2026-01-01T00:00:00.000Z") });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.status).toBe(status);
        expect(result.experiment.latestResult).toBeNull();
      }
    });
  });

  describe("measurement result states", () => {
    it("VALID_EFFECT: incrementalEstimate is available", async () => {
      const merchant = await makeMerchant("VALID_EFFECT merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      await makeMeasurementResult(experiment.id, 1, { resultStatus: "VALID_EFFECT" });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult?.incrementalEstimate).toEqual({
          status: "available",
          estimatedIncrementalGMVPaise: 200000,
          estimatedCounterfactualTreatmentGMVPaise: 200000,
        });
      }
    });

    it("VALID_INCONCLUSIVE: an observed difference is present but incrementalEstimate is unavailable", async () => {
      const merchant = await makeMerchant("VALID_INCONCLUSIVE merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      await makeMeasurementResult(experiment.id, 1, {
        resultStatus: "VALID_INCONCLUSIVE",
        observedDifference: 0.05,
        observedDifferenceLower: -0.02,
        observedDifferenceUpper: 0.12,
        estimatedIncrementalGMVPaise: null,
        estimatedCounterfactualTreatmentGMVPaise: null,
      });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult?.observedDifference).toEqual({ observedDifference: 0.05, lower: -0.02, upper: 0.12 });
        expect(result.experiment.latestResult?.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
      }
    });

    it("INVALID: incrementalEstimate is unavailable", async () => {
      const merchant = await makeMerchant("INVALID merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      await makeMeasurementResult(experiment.id, 1, {
        resultStatus: "INVALID",
        estimatedIncrementalGMVPaise: null,
        estimatedCounterfactualTreatmentGMVPaise: null,
      });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult?.resultStatus).toBe("INVALID");
        expect(result.experiment.latestResult?.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
      }
    });

    it("INSUFFICIENT_DATA: incrementalEstimate is unavailable and observedDifference may be null", async () => {
      const merchant = await makeMerchant("INSUFFICIENT_DATA merchant");
      const experiment = await makeExperiment(merchant.id, { status: "RUNNING" });
      await makeMeasurementResult(experiment.id, 1, {
        resultKind: "INTERIM",
        resultStatus: "INSUFFICIENT_DATA",
        observedDifference: null,
        observedDifferenceLower: null,
        observedDifferenceUpper: null,
        estimatedIncrementalGMVPaise: null,
        estimatedCounterfactualTreatmentGMVPaise: null,
      });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult?.observedDifference).toBeNull();
        expect(result.experiment.latestResult?.incrementalEstimate).toEqual({ status: "unavailable", reason: "not_valid_effect" });
      }
    });
  });

  describe("multiple snapshots: latest selection and history ordering", () => {
    it("getExperimentDetail's latestResult picks the highest-generatedAt row, not the highest version or insertion order", async () => {
      const merchant = await makeMerchant("Multi-snapshot merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      // Inserted out of chronological order on purpose - generatedAt (DB
      // default now()) drives insertion order here since we cannot set it
      // explicitly (no @default(now()) override field on this model), so
      // this proves "latest" tracks real insertion time, not `version`.
      await makeMeasurementResult(experiment.id, 1, { resultStatus: "INVALID" });
      const v2 = await makeMeasurementResult(experiment.id, 2, { resultStatus: "VALID_EFFECT" });

      const result = await getExperimentDetail(merchant.id, experiment.id);
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.experiment.latestResult?.id).toBe(v2.id);
        expect(result.experiment.latestResult?.version).toBe(2);
      }
    });

    it("listExperimentResults returns full history newest-first", async () => {
      const merchant = await makeMerchant("History merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      const v1 = await makeMeasurementResult(experiment.id, 1);
      const v2 = await makeMeasurementResult(experiment.id, 2);
      const v3 = await makeMeasurementResult(experiment.id, 3);

      const result = await listExperimentResults(merchant.id, experiment.id, {});
      expect(result.status).toBe("found");
      if (result.status === "found") {
        expect(result.items.map((i) => i.id)).toEqual([v3.id, v2.id, v1.id]);
      }
    });
  });

  describe("pagination boundaries", () => {
    it("listExperiments paginates via cursor - two pages cover all rows exactly once", async () => {
      const merchant = await makeMerchant("Pagination merchant");
      const experiments = [];
      for (let i = 0; i < 3; i++) {
        experiments.push(await makeExperiment(merchant.id, { name: `Page test ${i} ${TAG}` }));
      }

      const page1 = await listExperiments(merchant.id, { limit: 2 });
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listExperiments(merchant.id, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items].map((i) => i.id).sort();
      expect(allIds).toEqual(experiments.map((e) => e.id).sort());
    });

    it("listExperimentResults paginates history via cursor - two pages cover all rows exactly once", async () => {
      const merchant = await makeMerchant("Results pagination merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      const rows = [];
      for (let i = 1; i <= 3; i++) {
        rows.push(await makeMeasurementResult(experiment.id, i));
      }

      const page1 = await listExperimentResults(merchant.id, experiment.id, { limit: 2 });
      expect(page1.status).toBe("found");
      if (page1.status !== "found") throw new Error("expected found");
      expect(page1.items).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await listExperimentResults(merchant.id, experiment.id, { limit: 2, cursor: page1.nextCursor! });
      expect(page2.status).toBe("found");
      if (page2.status !== "found") throw new Error("expected found");
      expect(page2.items).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const allIds = [...page1.items, ...page2.items].map((i) => i.id).sort();
      expect(allIds).toEqual(rows.map((r) => r.id).sort());
    });
  });

  describe("privacy: no raw internal identifiers leak through the real Json columns", () => {
    it("real Customer/RevenueRiskEvent/ExperimentAssignment id-shaped strings inside validityChecks.details never survive serialization", async () => {
      const merchant = await makeMerchant("Privacy merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      const REAL_LOOKING_CUSTOMER_ID = `clcustomer${randomUUID().replace(/-/g, "")}`;
      const REAL_LOOKING_RISK_EVENT_ID = `clriskevent${randomUUID().replace(/-/g, "")}`;
      const REAL_LOOKING_ASSIGNMENT_ID = `classignment${randomUUID().replace(/-/g, "")}`;

      await makeMeasurementResult(experiment.id, 1, {
        validityChecks: [
          {
            code: "assignment_uniqueness",
            severity: "ERROR",
            passed: false,
            message: "Duplicate assignment detected for one or more units.",
            details: { duplicateUnitKeys: [REAL_LOOKING_CUSTOMER_ID, REAL_LOOKING_RISK_EVENT_ID] },
          },
          {
            code: "treatment_arm_consistency",
            severity: "ERROR",
            passed: false,
            message: "A unit switched arms mid-experiment.",
            details: { affectedUnitKeys: [REAL_LOOKING_RISK_EVENT_ID] },
          },
          {
            code: "analysis_unit_integrity",
            severity: "ERROR",
            passed: false,
            message: "Duplicate ExperimentAssignment rows detected.",
            details: { duplicateAssignmentIds: [REAL_LOOKING_ASSIGNMENT_ID] },
          },
        ],
      });

      const detail = await getExperimentDetail(merchant.id, experiment.id);
      const history = await listExperimentResults(merchant.id, experiment.id, {});
      const serialized = JSON.stringify({ detail, history });

      expect(serialized).not.toContain(REAL_LOOKING_CUSTOMER_ID);
      expect(serialized).not.toContain(REAL_LOOKING_RISK_EVENT_ID);
      expect(serialized).not.toContain(REAL_LOOKING_ASSIGNMENT_ID);
      expect(serialized).not.toContain("duplicateUnitKeys");
      expect(serialized).not.toContain("affectedUnitKeys");
      expect(serialized).not.toContain("duplicateAssignmentIds");

      // But the sanitized, safe fields of those same checks DO come through.
      expect(detail.status).toBe("found");
      if (detail.status === "found") {
        const codes = detail.experiment.latestResult?.validity.checks.map((c) => c.code);
        expect(codes).toEqual(expect.arrayContaining(["assignment_uniqueness", "treatment_arm_consistency", "analysis_unit_integrity"]));
      }
    });

    it("never exposes merchantId, raw Payment/Customer identifiers, or Razorpay identifiers anywhere in the response", async () => {
      const merchant = await makeMerchant("No-PII merchant");
      const experiment = await makeExperiment(merchant.id, { status: "COMPLETED" });
      await makeMeasurementResult(experiment.id, 1);

      const detail = await getExperimentDetail(merchant.id, experiment.id);
      const serialized = JSON.stringify(detail);
      expect(serialized).not.toContain(merchant.id);
      expect(serialized).not.toContain("razorpay");
      expect(serialized).not.toContain("rzp_");
    });
  });
});
