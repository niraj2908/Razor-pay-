import { beforeEach, describe, expect, it, vi } from "vitest";

const experimentFindUnique = vi.fn();
const experimentAssignmentFindMany = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    experiment: { findUnique: experimentFindUnique },
    experimentAssignment: { findMany: experimentAssignmentFindMany },
  },
}));

const { computeExperimentResult } = await import("./experimentResultService");

const NOW = new Date("2026-02-01T00:00:00.000Z");
const DECIDED_AT = new Date("2026-01-01T00:00:00.000Z");
const ASSIGNED_AT = new Date("2025-12-31T00:00:00.000Z");

function baseExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: "exp_1",
    status: "RUNNING",
    startedAt: new Date("2025-12-01T00:00:00.000Z"),
    endedAt: null,
    treatmentAllocationPercent: 50,
    ...overrides,
  };
}

function assignmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "assignment_1",
    experimentId: "exp_1",
    unitType: "CANDIDATE",
    unitKey: "risk_1",
    arm: "TREATMENT",
    assignedAt: ASSIGNED_AT,
    revenueRiskEvents: [
      {
        id: "risk_1",
        decisions: [
          {
            id: "decision_1",
            decidedAt: DECIDED_AT,
            executions: [],
            outcome: { status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 5000 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("computeExperimentResult", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns experiment_not_found without querying assignments", async () => {
    experimentFindUnique.mockResolvedValue(null);

    const result = await computeExperimentResult("exp_missing", 0.95);

    expect(result).toEqual({ status: "experiment_not_found" });
    expect(experimentAssignmentFindMany).not.toHaveBeenCalled();
  });

  it("queries assignments scoped to exactly the requested experiment", async () => {
    experimentFindUnique.mockResolvedValue(baseExperiment());
    experimentAssignmentFindMany.mockResolvedValue([]);

    await computeExperimentResult("exp_1", 0.95, { now: NOW });

    expect(experimentAssignmentFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { experimentId: "exp_1" } })
    );
  });

  it("assembles a full result with version metadata and a computed timestamp", async () => {
    experimentFindUnique.mockResolvedValue(baseExperiment());
    experimentAssignmentFindMany.mockResolvedValue([
      assignmentRow(),
      assignmentRow({
        id: "assignment_2",
        unitType: "CANDIDATE",
        unitKey: "risk_2",
        arm: "CONTROL",
        revenueRiskEvents: [
          {
            id: "risk_2",
            decisions: [{ id: "decision_2", decidedAt: DECIDED_AT, executions: [], outcome: { status: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null } }],
          },
        ],
      }),
    ]);

    const outcome = await computeExperimentResult("exp_1", 0.95, { now: NOW, minimumAnalyzableSamplePerArm: 1 });

    expect(outcome.status).toBe("computed");
    if (outcome.status !== "computed") return;
    const { result } = outcome;

    expect(result.experimentId).toBe("exp_1");
    expect(result.calculatedAt).toBe(NOW.toISOString());
    expect(result.eligibilityLogicVersion).toBe("eligibility-v1");
    expect(result.statisticalMethodVersion).toBe("statistics-v1");
    expect(result.validityLogicVersion).toBe("validity-v1");
    expect(result.treatment.recoveryRate).toMatchObject({ arm: "TREATMENT", analyzableUnits: 1, successes: 1 });
    expect(result.control.recoveryRate).toMatchObject({ arm: "CONTROL", analyzableUnits: 1, successes: 0 });
    expect(result.validity.status).toBe("VALID");
    expect(result.sampleSize).toBeNull(); // no sampleSizeConfig supplied
  });

  it("computes sampleSize only when a config is explicitly supplied - never a fabricated default", async () => {
    experimentFindUnique.mockResolvedValue(baseExperiment());
    experimentAssignmentFindMany.mockResolvedValue([]);

    const withoutConfig = await computeExperimentResult("exp_1", 0.95, { now: NOW });
    const withConfig = await computeExperimentResult("exp_1", 0.95, {
      now: NOW,
      sampleSizeConfig: { baselineRate: 0.1, minimumDetectableEffect: 0.05, alpha: 0.05, power: 0.8, treatmentAllocationPercent: 50 },
    });

    if (withoutConfig.status !== "computed" || withConfig.status !== "computed") throw new Error("expected computed");
    expect(withoutConfig.result.sampleSize).toBeNull();
    expect(withConfig.result.sampleSize?.status).toBe("computed");
  });

  it("a CONTROL unit with an Execution row is surfaced as contamination via validity, arm never reassigned", async () => {
    experimentFindUnique.mockResolvedValue(baseExperiment());
    experimentAssignmentFindMany.mockResolvedValue([
      assignmentRow({
        id: "assignment_contaminated",
        unitKey: "risk_contaminated",
        arm: "CONTROL",
        revenueRiskEvents: [
          {
            id: "risk_contaminated",
            decisions: [
              {
                id: "decision_c",
                decidedAt: DECIDED_AT,
                executions: [{ status: "SUCCEEDED", actionType: "PAYMENT_LINK" }],
                outcome: null,
              },
            ],
          },
        ],
      }),
    ]);

    const outcome = await computeExperimentResult("exp_1", 0.95, { now: NOW });
    if (outcome.status !== "computed") throw new Error("expected computed");

    const contaminationCheck = outcome.result.validity.checks.find((c) => c.code === "control_contamination");
    expect(contaminationCheck).toMatchObject({ passed: false });
    expect(outcome.result.validity.status).toBe("INVALID");
  });

  it("picks the earliest Decision deterministically when a RevenueRiskEvent has more than one (defensive, not expected in current production behavior)", async () => {
    experimentFindUnique.mockResolvedValue(baseExperiment());
    experimentAssignmentFindMany.mockResolvedValue([
      assignmentRow({
        revenueRiskEvents: [
          {
            id: "risk_1",
            decisions: [
              { id: "decision_later", decidedAt: new Date("2026-01-02T00:00:00.000Z"), executions: [], outcome: null },
              { id: "decision_earlier", decidedAt: DECIDED_AT, executions: [], outcome: { status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 1000 } },
            ],
          },
        ],
      }),
    ]);

    const outcome = await computeExperimentResult("exp_1", 0.95, { now: NOW });
    if (outcome.status !== "computed") throw new Error("expected computed");
    // The earlier decision's outcome (a real recovery) should be the one used.
    expect(outcome.result.treatment.recoveryRate.successes).toBe(1);
  });
});
