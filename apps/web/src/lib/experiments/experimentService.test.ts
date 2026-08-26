import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const experiments = new Map<string, Row>();
  const assignments = new Map<string, Row>();
  let idCounter = 0;

  const experimentFindFirst = vi.fn(async ({ where, orderBy }: { where: { status: string }; orderBy?: { startedAt: string } }) => {
    const matches = [...experiments.values()].filter((e) => e.status === where.status);
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const aTime = a.startedAt ? (a.startedAt as Date).getTime() : Infinity;
      const bTime = b.startedAt ? (b.startedAt as Date).getTime() : Infinity;
      return orderBy?.startedAt === "desc" ? bTime - aTime : aTime - bTime;
    });
    return matches[0];
  });

  const assignmentFindFirst = vi.fn(async ({ where }: { where: { unitType: string; unitKey: string } }) =>
    [...assignments.values()].find((a) => a.unitType === where.unitType && a.unitKey === where.unitKey) ?? null
  );

  const assignmentCreate = vi.fn(async ({ data }: { data: Row }) => {
    const key = `${data.experimentId}:${data.unitType}:${data.unitKey}`;
    if ([...assignments.values()].some((a) => `${a.experimentId}:${a.unitType}:${a.unitKey}` === key)) {
      const error = new Error("Unique constraint failed") as Error & { code: string };
      error.code = "P2002";
      throw error;
    }
    const row = { id: `assignment_${++idCounter}`, ...data };
    assignments.set(row.id as string, row);
    return row;
  });

  const assignmentFindUniqueOrThrow = vi.fn(
    async ({ where }: { where: { experimentId_unitType_unitKey: { experimentId: string; unitType: string; unitKey: string } } }) => {
      const { experimentId, unitType, unitKey } = where.experimentId_unitType_unitKey;
      const row = [...assignments.values()].find(
        (a) => a.experimentId === experimentId && a.unitType === unitType && a.unitKey === unitKey
      );
      if (!row) throw new Error("ExperimentAssignment not found");
      return row;
    }
  );

  const auditEventCreate = vi.fn(async () => ({ id: "audit_1" }));

  return {
    experiments,
    assignments,
    reset: () => {
      experiments.clear();
      assignments.clear();
      idCounter = 0;
    },
    experimentFindFirst,
    assignmentFindFirst,
    assignmentCreate,
    assignmentFindUniqueOrThrow,
    auditEventCreate,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    experiment: { findFirst: mocks.experimentFindFirst },
    experimentAssignment: {
      findFirst: mocks.assignmentFindFirst,
      create: mocks.assignmentCreate,
      findUniqueOrThrow: mocks.assignmentFindUniqueOrThrow,
    },
    auditEvent: { create: mocks.auditEventCreate },
  },
}));

const {
  resolveExperimentAssignment,
  isExecutionAllowed,
  checkCandidateEligibility,
  canAssignNewCandidates,
} = await import("./experimentService");

const NOW = new Date("2026-01-01T00:00:00.000Z");

function runningExperiment(overrides: Record<string, unknown> = {}) {
  return {
    id: "exp_1",
    status: "RUNNING",
    treatmentAllocationPercent: 100, // force TREATMENT deterministically for most tests
    startedAt: new Date("2025-12-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("resolveExperimentAssignment", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
  });

  it("1. a RUNNING experiment assigns an eligible candidate", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    expect(result.outcome).toBe("assigned");
    if (result.outcome === "assigned") {
      expect(result.assignment.arm).toBe("TREATMENT");
      expect(result.assignment.experimentId).toBe("exp_1");
    }
  });

  it("2. a DRAFT experiment does not assign", async () => {
    mocks.experiments.set("exp_1", runningExperiment({ status: "DRAFT" }));
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    expect(result).toEqual({ outcome: "no_running_experiment" });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("3. a PAUSED experiment does not assign", async () => {
    mocks.experiments.set("exp_1", runningExperiment({ status: "PAUSED" }));
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    expect(result).toEqual({ outcome: "no_running_experiment" });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("4. a COMPLETED experiment does not assign", async () => {
    mocks.experiments.set("exp_1", runningExperiment({ status: "COMPLETED" }));
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    expect(result).toEqual({ outcome: "no_running_experiment" });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("9. a duplicate assignment request for the same participant reuses the existing row (no second insert)", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    const first = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    const second = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_2", paymentState: "FAILED" },
      NOW
    );
    expect(first.outcome).toBe("assigned");
    expect(second.outcome).toBe("assigned");
    if (first.outcome === "assigned" && second.outcome === "assigned") {
      expect(second.assignment.id).toBe(first.assignment.id);
    }
    expect(mocks.assignmentCreate).toHaveBeenCalledTimes(1);
  });

  it("11. a CUSTOMER-level assignment is reused across multiple candidates for the same customer", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    const candidate1 = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    const candidate2 = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_2", paymentState: "FAILED" },
      NOW
    );
    const candidate3 = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_3", paymentState: "FAILED" },
      NOW
    );
    for (const r of [candidate1, candidate2, candidate3]) {
      expect(r.outcome).toBe("assigned");
      if (r.outcome === "assigned") expect(r.assignment.arm).toBe("TREATMENT");
    }
  });

  it("12. a guest candidate (no customerId) uses the CANDIDATE-level fallback", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    const result = await resolveExperimentAssignment(
      { customerId: null, candidateKey: "risk_guest_1", paymentState: "FAILED" },
      NOW
    );
    expect(result.outcome).toBe("assigned");
    if (result.outcome === "assigned") {
      expect(result.assignment.unitType).toBe("CANDIDATE");
      expect(result.assignment.unitKey).toBe("risk_guest_1");
    }
  });

  it("18. an ineligible candidate (payment already captured) receives no assignment at all - never forced into CONTROL", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "CAPTURED" },
      NOW
    );
    expect(result).toEqual({ outcome: "ineligible", reasons: ["payment_state_ineligible:CAPTURED"] });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("19. the assignment algorithm/version is persisted on every new assignment", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    await resolveExperimentAssignment({ customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" }, NOW);
    const created = [...mocks.assignments.values()][0];
    expect(created.assignmentAlgorithm).toBe("sha256-v1");
    expect(created.eligibilityVersion).toBe("eligibility-v1");
  });

  it("21. a unit already assigned to a DIFFERENT experiment is excluded, not double-enrolled", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    mocks.assignments.set("existing_1", {
      id: "existing_1",
      experimentId: "exp_other",
      unitType: "CUSTOMER",
      unitKey: "cust_1",
      arm: "TREATMENT",
    });
    const result = await resolveExperimentAssignment(
      { customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" },
      NOW
    );
    expect(result).toEqual({ outcome: "excluded_overlap", existingExperimentId: "exp_other" });
    expect(mocks.assignmentCreate).not.toHaveBeenCalled();
  });

  it("assignedAt is set explicitly from the passed-in `now`, not an implicit DB default", async () => {
    mocks.experiments.set("exp_1", runningExperiment());
    await resolveExperimentAssignment({ customerId: "cust_1", candidateKey: "risk_1", paymentState: "FAILED" }, NOW);
    const created = [...mocks.assignments.values()][0];
    expect(created.assignedAt).toBe(NOW);
  });
});

describe("isExecutionAllowed", () => {
  it("14. CONTROL cannot reach execution", () => {
    expect(
      isExecutionAllowed({
        outcome: "assigned",
        assignment: {
          id: "a1",
          experimentId: "exp_1",
          unitType: "CUSTOMER",
          unitKey: "cust_1",
          arm: "CONTROL",
          assignedAt: NOW,
          eligibilityVersion: "eligibility-v1",
          assignmentAlgorithm: "sha256-v1",
        },
      })
    ).toBe(false);
  });

  it("13. TREATMENT is allowed to reach normal execution evaluation", () => {
    expect(
      isExecutionAllowed({
        outcome: "assigned",
        assignment: {
          id: "a1",
          experimentId: "exp_1",
          unitType: "CUSTOMER",
          unitKey: "cust_1",
          arm: "TREATMENT",
          assignedAt: NOW,
          eligibilityVersion: "eligibility-v1",
          assignmentAlgorithm: "sha256-v1",
        },
      })
    ).toBe(true);
  });

  it("no experiment, ineligible, or excluded_overlap never restrict execution", () => {
    expect(isExecutionAllowed({ outcome: "no_running_experiment" })).toBe(true);
    expect(isExecutionAllowed({ outcome: "ineligible", reasons: ["x"] })).toBe(true);
    expect(isExecutionAllowed({ outcome: "excluded_overlap", existingExperimentId: "exp_x" })).toBe(true);
  });
});

describe("checkCandidateEligibility", () => {
  it("rejects CAPTURED, AUTHORIZED, and REFUNDED payment states", () => {
    expect(checkCandidateEligibility({ paymentState: "CAPTURED" }).eligible).toBe(false);
    expect(checkCandidateEligibility({ paymentState: "AUTHORIZED" }).eligible).toBe(false);
    expect(checkCandidateEligibility({ paymentState: "REFUNDED" }).eligible).toBe(false);
  });

  it("accepts FAILED and CREATED payment states", () => {
    expect(checkCandidateEligibility({ paymentState: "FAILED" }).eligible).toBe(true);
    expect(checkCandidateEligibility({ paymentState: "CREATED" }).eligible).toBe(true);
  });
});

describe("canAssignNewCandidates", () => {
  it("is true only for RUNNING", () => {
    expect(canAssignNewCandidates("RUNNING")).toBe(true);
    expect(canAssignNewCandidates("DRAFT")).toBe(false);
    expect(canAssignNewCandidates("PAUSED")).toBe(false);
    expect(canAssignNewCandidates("COMPLETED")).toBe(false);
  });
});
