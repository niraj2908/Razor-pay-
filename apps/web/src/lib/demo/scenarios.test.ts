import { describe, expect, it } from "vitest";
import { evaluateRecoveryDecision } from "@/lib/recovery/decisionEngine";
import { DEMO_DECISION_SCENARIOS, buildScenarioContext } from "./scenarios";

/**
 * Proves every Demo Workspace scenario legitimately produces its claimed
 * decision under the REAL, unmodified decision engine - never asserts
 * against a hand-typed expectation the engine wasn't actually shown to
 * satisfy. If a future change to decisionEngine.ts/policy.ts/safetyGate.ts/
 * the model tables ever shifts one of these scenarios to a different
 * decision, this test fails loudly rather than letting the seed script
 * silently persist a mismatched/misleading demo dataset.
 */
describe("Demo Workspace decision scenarios against the real decision engine", () => {
  for (const scenario of DEMO_DECISION_SCENARIOS) {
    it(`${scenario.key}: ${scenario.label} -> ${scenario.expectedDecision}`, () => {
      const context = buildScenarioContext(scenario, "demo_payment_placeholder", "demo_merchant_placeholder");
      const trace = evaluateRecoveryDecision(context);

      expect(trace.selectedAction).toBe(scenario.expectedDecision);
      expect(trace.reason).toContain(scenario.expectedReason);
    });
  }

  it("covers all four RecoveryDecision values at least once", () => {
    const decisions = new Set(DEMO_DECISION_SCENARIOS.map((s) => s.expectedDecision));
    expect(decisions).toEqual(new Set(["ACT", "WAIT", "STOP", "ESCALATE"]));
  });

  it("act_retry_network prices RETRY highest but selects the executable PAYMENT_LINK instead", () => {
    const scenario = DEMO_DECISION_SCENARIOS.find((s) => s.key === "act_retry_network")!;
    const context = buildScenarioContext(scenario, "p", "m");
    const trace = evaluateRecoveryDecision(context);
    expect(trace.expectedValues.RETRY).toBeGreaterThan(trace.expectedValues.PAYMENT_LINK);
    expect(trace.selectedStrategy).toBe("PAYMENT_LINK");
    expect(trace.unexecutableBestStrategy).toBe("RETRY");
  });

  it("act_payment_link_abandonment and act_payment_link_other_recoverable legitimately select PAYMENT_LINK", () => {
    for (const key of ["act_payment_link_abandonment", "act_payment_link_other_recoverable"]) {
      const scenario = DEMO_DECISION_SCENARIOS.find((s) => s.key === key)!;
      const context = buildScenarioContext(scenario, "p", "m");
      const trace = evaluateRecoveryDecision(context);
      expect(trace.selectedStrategy).toBe("PAYMENT_LINK");
    }
  });
});
