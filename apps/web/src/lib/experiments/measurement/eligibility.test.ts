import { describe, expect, it } from "vitest";
import { classifyAssignmentCandidates, classifyCandidate, classifyMaturity } from "./eligibility";
import { AssignmentRecord, CandidateRecord, ExperimentWindowRecord } from "./types";
import { DEFAULT_ATTRIBUTION_POLICY } from "@/lib/outcomes/attributionEngine";

const NOW = new Date("2026-01-02T00:00:00.000Z");
const DECIDED_AT = new Date("2026-01-01T00:00:00.000Z"); // 24h before NOW
const ASSIGNED_AT = new Date("2025-12-31T23:00:00.000Z"); // 1h before decidedAt

const EXPERIMENT_WINDOW: ExperimentWindowRecord = {
  startedAt: new Date("2025-12-01T00:00:00.000Z"),
  endedAt: null,
};

function candidate(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    revenueRiskEventId: "risk_1",
    decision: { id: "decision_1", decidedAt: DECIDED_AT },
    execution: null,
    outcome: null,
    ...overrides,
  };
}

describe("classifyMaturity", () => {
  it("no outcome, window still open -> NOT_YET_MATURE", () => {
    const result = classifyMaturity(null, NOW, null, NOW, DEFAULT_ATTRIBUTION_POLICY);
    expect(result.maturity).toBe("NOT_YET_MATURE");
    expect(result.windowClosed).toBe(false);
  });

  it("PENDING outcome -> NOT_YET_MATURE regardless of window", () => {
    const result = classifyMaturity(
      { status: "PENDING", attributionStatus: null, recoveredAmount: null },
      DECIDED_AT,
      null,
      NOW,
      DEFAULT_ATTRIBUTION_POLICY
    );
    expect(result.maturity).toBe("NOT_YET_MATURE");
  });

  it("NOT_RECOVERED -> MATURED_FAILURE", () => {
    const result = classifyMaturity(
      { status: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null },
      DECIDED_AT,
      null,
      NOW,
      DEFAULT_ATTRIBUTION_POLICY
    );
    expect(result.maturity).toBe("MATURED_FAILURE");
  });

  it("RECOVERED with resolved attribution -> MATURED_SUCCESS", () => {
    const result = classifyMaturity(
      { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 10000 },
      DECIDED_AT,
      null,
      NOW,
      DEFAULT_ATTRIBUTION_POLICY
    );
    expect(result.maturity).toBe("MATURED_SUCCESS");
  });

  it("RECOVERED with UNKNOWN attribution -> MATURED_UNKNOWN", () => {
    const result = classifyMaturity(
      { status: "RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: 10000 },
      DECIDED_AT,
      null,
      NOW,
      DEFAULT_ATTRIBUTION_POLICY
    );
    expect(result.maturity).toBe("MATURED_UNKNOWN");
  });

  it("windowClosed is reported correctly for a still-missing Outcome past the window", () => {
    const longAgo = new Date(DECIDED_AT.getTime() - 2 * 24 * 60 * 60 * 1000);
    const result = classifyMaturity(null, longAgo, null, NOW, DEFAULT_ATTRIBUTION_POLICY);
    expect(result.maturity).toBe("NOT_YET_MATURE");
    expect(result.windowClosed).toBe(true);
  });
});

describe("classifyCandidate", () => {
  it("1. mature recovered (resolved attribution) -> ANALYZABLE / MATURED_SUCCESS", () => {
    const c = candidate({ outcome: { status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 5000 } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "ANALYZABLE", reason: null, maturity: "MATURED_SUCCESS", recoveredAmount: 5000 });
  });

  it("2. mature failed -> ANALYZABLE / MATURED_FAILURE", () => {
    const c = candidate({ outcome: { status: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "ANALYZABLE", reason: null, maturity: "MATURED_FAILURE" });
  });

  it("3. immature (no outcome, window open) -> NOT_ANALYZABLE / outcome_not_mature, never treated as failure", () => {
    const recentDecision = candidate({ decision: { id: "d1", decidedAt: NOW } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, recentDecision, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "outcome_not_mature" });
    expect(result.maturity).not.toBe("MATURED_FAILURE");
  });

  it("immature past window with no Outcome row -> NOT_ANALYZABLE / missing_outcome_past_window (data gap, not ordinary immaturity)", () => {
    const withinWindowAssignedAt = new Date("2025-12-01T00:00:00.000Z"); // == experiment startedAt, still valid
    const staleDecision = candidate({ decision: { id: "d1", decidedAt: new Date("2025-12-01T00:10:00.000Z") } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: withinWindowAssignedAt }, staleDecision, NOW, DEFAULT_ATTRIBUTION_POLICY);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "missing_outcome_past_window" });
  });

  it("4. unknown attribution -> NOT_ANALYZABLE / unresolved_attribution, amount still carried for sensitivity", () => {
    const c = candidate({ outcome: { status: "RECOVERED", attributionStatus: "UNKNOWN", recoveredAmount: 7500 } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "unresolved_attribution", maturity: "MATURED_UNKNOWN", recoveredAmount: 7500 });
  });

  it("5. invalid assignment (bad arm) -> NOT_ANALYZABLE / invalid_assignment", () => {
    const c = candidate();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "BOGUS" as any, assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "invalid_assignment" });
  });

  it("6. control contamination -> NOT_ANALYZABLE / control_contamination even when the execution itself failed", () => {
    const c = candidate({ execution: { status: "FAILED", actionType: "PAYMENT_LINK" } });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "CONTROL", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "control_contamination" });
  });

  it("missing decision -> NOT_ANALYZABLE / missing_decision", () => {
    const c = candidate({ decision: null });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "missing_decision" });
  });

  it("assignment after decision -> NOT_ANALYZABLE / assignment_after_decision", () => {
    const c = candidate();
    const laterAssignment = new Date(DECIDED_AT.getTime() + 60_000);
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: laterAssignment }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "assignment_after_decision" });
  });

  it("assignment before experiment started -> NOT_ANALYZABLE / assignment_outside_experiment_window", () => {
    const c = candidate();
    const beforeStart = new Date("2020-01-01T00:00:00.000Z");
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: beforeStart }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "assignment_outside_experiment_window" });
  });

  it("assignment after experiment ended -> NOT_ANALYZABLE / assignment_outside_experiment_window", () => {
    const endedWindow: ExperimentWindowRecord = { startedAt: EXPERIMENT_WINDOW.startedAt, endedAt: new Date("2025-12-15T00:00:00.000Z") };
    const c = candidate();
    const result = classifyCandidate(endedWindow, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result).toMatchObject({ status: "NOT_ANALYZABLE", reason: "assignment_outside_experiment_window" });
  });

  it("TREATMENT with a real execution is never itself contamination", () => {
    const c = candidate({
      execution: { status: "SUCCEEDED", actionType: "PAYMENT_LINK" },
      outcome: { status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 5000 },
    });
    const result = classifyCandidate(EXPERIMENT_WINDOW, { arm: "TREATMENT", assignedAt: ASSIGNED_AT }, c, NOW);
    expect(result.status).toBe("ANALYZABLE");
  });
});

describe("classifyAssignmentCandidates", () => {
  it("an assignment with zero candidates classifies as missing_candidate rather than an empty array", () => {
    const assignment: AssignmentRecord = { id: "a1", unitType: "CANDIDATE", unitKey: "k1", arm: "TREATMENT", assignedAt: ASSIGNED_AT, candidates: [] };
    const results = classifyAssignmentCandidates(EXPERIMENT_WINDOW, assignment, NOW);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "NOT_ANALYZABLE", reason: "missing_candidate" });
  });

  it("classifies every candidate under a multi-candidate assignment independently", () => {
    const assignment: AssignmentRecord = {
      id: "a1",
      unitType: "CUSTOMER",
      unitKey: "cust_1",
      arm: "TREATMENT",
      assignedAt: ASSIGNED_AT,
      candidates: [
        candidate({ revenueRiskEventId: "risk_a", outcome: { status: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 1000 } }),
        candidate({ revenueRiskEventId: "risk_b", outcome: { status: "NOT_RECOVERED", attributionStatus: null, recoveredAmount: null } }),
      ],
    };
    const results = classifyAssignmentCandidates(EXPERIMENT_WINDOW, assignment, NOW);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.maturity)).toEqual(["MATURED_SUCCESS", "MATURED_FAILURE"]);
  });
});
