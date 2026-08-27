import { describe, expect, it } from "vitest";
import { buildAnalysisUnit } from "./analysisUnit";
import { CandidateClassification } from "./eligibility";

function success(id: string, amount: number): CandidateClassification {
  return { revenueRiskEventId: id, status: "ANALYZABLE", reason: null, maturity: "MATURED_SUCCESS", recoveredAmount: amount };
}
function failure(id: string): CandidateClassification {
  return { revenueRiskEventId: id, status: "ANALYZABLE", reason: null, maturity: "MATURED_FAILURE", recoveredAmount: null };
}
function notYetMature(id: string): CandidateClassification {
  return { revenueRiskEventId: id, status: "NOT_ANALYZABLE", reason: "outcome_not_mature", maturity: "NOT_YET_MATURE", recoveredAmount: null };
}
function unknown(id: string, amount: number): CandidateClassification {
  return { revenueRiskEventId: id, status: "NOT_ANALYZABLE", reason: "unresolved_attribution", maturity: "MATURED_UNKNOWN", recoveredAmount: amount };
}

const ASSIGNMENT = { id: "a1", unitType: "CANDIDATE" as const, unitKey: "risk_1", arm: "TREATMENT" as const };

describe("buildAnalysisUnit", () => {
  it("guest candidate: a single analyzable success rolls up directly", () => {
    const unit = buildAnalysisUnit(ASSIGNMENT, [success("risk_1", 5000)]);
    expect(unit).toMatchObject({ status: "ANALYZABLE", outcome: "SUCCESS", recoveredAmount: 5000, candidateCount: 1 });
  });

  it("customer with one candidate: identical shape to a guest candidate", () => {
    const unit = buildAnalysisUnit({ ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_1" }, [failure("risk_1")]);
    expect(unit).toMatchObject({ status: "ANALYZABLE", outcome: "FAILURE", recoveredAmount: 0 });
  });

  it("customer with multiple candidates: ANY success -> unit SUCCESS (one vote, not N votes)", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_multi" },
      [failure("risk_a"), success("risk_b", 3000), failure("risk_c")]
    );
    expect(unit.outcome).toBe("SUCCESS");
  });

  it("customer with multiple candidates: GMV sums across ALL analyzable successes, not just one", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_multi_success" },
      [success("risk_a", 3000), success("risk_b", 2000)]
    );
    expect(unit.recoveredAmount).toBe(5000);
    expect(unit.analyzableSuccessCount).toBe(2);
  });

  it("a customer with all candidates unresolved (no analyzable candidate at all) -> unit NOT_ANALYZABLE", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_pending" },
      [notYetMature("risk_a"), notYetMature("risk_b")]
    );
    expect(unit).toMatchObject({ status: "NOT_ANALYZABLE", outcome: null, recoveredAmount: 0 });
    expect(unit.exclusionReasons).toEqual(["outcome_not_mature"]);
  });

  it("a unit with one analyzable failure and one still-pending candidate is ANALYZABLE using only the resolved one", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_mixed" },
      [failure("risk_a"), notYetMature("risk_b")]
    );
    expect(unit).toMatchObject({ status: "ANALYZABLE", outcome: "FAILURE" });
    expect(unit.exclusionReasons).toEqual(["outcome_not_mature"]);
  });

  it("tracks matured-unknown candidates separately without ever contributing to outcome/recoveredAmount on their own", () => {
    const unit = buildAnalysisUnit({ ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_unknown_only" }, [unknown("risk_a", 9000)]);
    expect(unit).toMatchObject({ status: "NOT_ANALYZABLE", outcome: null, recoveredAmount: 0, maturedUnknownCandidateCount: 1 });
  });

  it("a matured-unknown candidate alongside an analyzable success still counts the unit as SUCCESS via the resolved candidate", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_mixed_unknown" },
      [success("risk_a", 4000), unknown("risk_b", 9000)]
    );
    expect(unit).toMatchObject({ status: "ANALYZABLE", outcome: "SUCCESS", recoveredAmount: 4000, maturedUnknownCandidateCount: 1 });
  });

  it("distinct exclusion reasons are deduplicated", () => {
    const unit = buildAnalysisUnit(
      { ...ASSIGNMENT, unitType: "CUSTOMER", unitKey: "cust_dupe_reasons" },
      [notYetMature("risk_a"), notYetMature("risk_b")]
    );
    expect(unit.exclusionReasons).toHaveLength(1);
  });
});
