import { describe, expect, it } from "vitest";
import {
  AttributionContext,
  evaluateOutcomeAttribution,
  isAttributionWindowClosed,
  DEFAULT_ATTRIBUTION_POLICY,
} from "./attributionEngine";

function baseContext(overrides: Partial<AttributionContext> = {}): AttributionContext {
  return {
    decisionId: "decision_1",
    originalPayment: { status: "FAILED", amount: 10000 },
    execution: null,
    recoveredPayment: null,
    weakEvidenceOnly: [],
    attributionWindowClosed: false,
    ...overrides,
  };
}

describe("evaluateOutcomeAttribution", () => {
  it("1. WAIT (no execution) + payment later captured -> NATURAL_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({ execution: null, originalPayment: { status: "CAPTURED", amount: 10000 } })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "NATURAL_RECOVERY", recoveredAmount: 10000 });
  });

  it("2. PAYMENT_LINK execution + deterministically linked captured payment -> INTERVENTION_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "PAYMENT_LINK", status: "SUCCEEDED" },
        recoveredPayment: { status: "CAPTURED", amount: 10000 },
      })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 10000 });
  });

  it("3. CAPTURE execution + same payment now captured -> INTERVENTION_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "CAPTURE", status: "SUCCEEDED" },
        originalPayment: { status: "CAPTURED", amount: 10000 },
      })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY", recoveredAmount: 10000 });
  });

  it("4. failed payment with attribution window still open -> PENDING, never permanently FAILED", () => {
    const result = evaluateOutcomeAttribution(baseContext({ attributionWindowClosed: false }));
    expect(result.outcomeStatus).toBe("PENDING");
  });

  it("5. failed payment after the window closes with no recovery -> NOT_RECOVERED (this codebase's FAILED)", () => {
    const result = evaluateOutcomeAttribution(baseContext({ attributionWindowClosed: true }));
    expect(result).toMatchObject({ outcomeStatus: "NOT_RECOVERED", attributionStatus: null });
  });

  it("6. ambiguous execution relationship -> UNKNOWN, never silently NATURAL_RECOVERY or FAILED", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({ execution: { actionType: "PAYMENT_LINK", status: "AMBIGUOUS" } })
    );
    expect(result.attributionStatus).toBe("UNKNOWN");
    expect(result.outcomeStatus).not.toBe("NOT_RECOVERED"); // window still open in this case
  });

  it("7. amount-only match is never used to confirm recovery -> UNKNOWN", () => {
    const result = evaluateOutcomeAttribution(baseContext({ weakEvidenceOnly: ["amount"] }));
    expect(result.attributionStatus).toBe("UNKNOWN");
    expect(result.outcomeStatus).not.toBe("RECOVERED");
  });

  it("8. email-only match is never used to confirm recovery -> UNKNOWN", () => {
    const result = evaluateOutcomeAttribution(baseContext({ weakEvidenceOnly: ["email"] }));
    expect(result.attributionStatus).toBe("UNKNOWN");
    expect(result.outcomeStatus).not.toBe("RECOVERED");
  });

  it("13. Payment Link created but customer never pays (window closed) -> NOT INTERVENTION_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({ execution: { actionType: "PAYMENT_LINK", status: "SUCCEEDED" }, attributionWindowClosed: true })
    );
    expect(result.attributionStatus).not.toBe("INTERVENTION_RECOVERY");
    expect(result.outcomeStatus).toBe("NOT_RECOVERED");
  });

  it("14. Execution succeeded (CAPTURE) but payment never shows captured -> NOT INTERVENTION_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "CAPTURE", status: "SUCCEEDED" },
        originalPayment: { status: "AUTHORIZED", amount: 10000 },
        attributionWindowClosed: false,
      })
    );
    expect(result.attributionStatus).not.toBe("INTERVENTION_RECOVERY");
    expect(result.outcomeStatus).toBe("PENDING"); // Execution.status=SUCCEEDED alone never proves recovery
  });

  it("15. ambiguous CAPTURE result where the payment IS captured -> UNKNOWN, not a confident INTERVENTION_RECOVERY", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "CAPTURE", status: "AMBIGUOUS" },
        originalPayment: { status: "CAPTURED", amount: 10000 },
      })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "UNKNOWN" });
  });

  it("16. natural recovery without execution requires the payment to actually show captured", () => {
    const notCaptured = evaluateOutcomeAttribution(baseContext({ execution: null, originalPayment: { status: "AUTHORIZED", amount: 10000 } }));
    expect(notCaptured.attributionStatus).not.toBe("NATURAL_RECOVERY");

    const captured = evaluateOutcomeAttribution(baseContext({ execution: null, originalPayment: { status: "CAPTURED", amount: 10000 } }));
    expect(captured.attributionStatus).toBe("NATURAL_RECOVERY");
  });

  it("19. recoveredAmount is always an integer number of paise", () => {
    const result = evaluateOutcomeAttribution(baseContext({ originalPayment: { status: "CAPTURED", amount: 123456 } }));
    expect(Number.isInteger(result.recoveredAmount)).toBe(true);
    expect(result.recoveredAmount).toBe(123456);
  });

  it("20. attribution is perfectly reproducible from the same evidence", () => {
    const context = baseContext({
      execution: { actionType: "PAYMENT_LINK", status: "SUCCEEDED" },
      recoveredPayment: { status: "CAPTURED", amount: 5000 },
    });
    const first = evaluateOutcomeAttribution(context);
    const second = evaluateOutcomeAttribution(context);
    expect(first).toEqual(second);
  });

  it("a FAILED PAYMENT_LINK execution falls back to checking natural recovery on the original payment", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "PAYMENT_LINK", status: "FAILED" },
        originalPayment: { status: "CAPTURED", amount: 10000 },
      })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "NATURAL_RECOVERY" });
  });

  it("a FAILED CAPTURE execution where the payment is captured anyway is NATURAL_RECOVERY, not ours", () => {
    const result = evaluateOutcomeAttribution(
      baseContext({
        execution: { actionType: "CAPTURE", status: "FAILED" },
        originalPayment: { status: "CAPTURED", amount: 10000 },
      })
    );
    expect(result).toMatchObject({ outcomeStatus: "RECOVERED", attributionStatus: "NATURAL_RECOVERY" });
  });
});

describe("isAttributionWindowClosed", () => {
  const decidedAt = new Date("2026-01-01T00:00:00.000Z");

  it("uses a shorter window for CAPTURE than PAYMENT_LINK", () => {
    const oneHourLater = new Date("2026-01-01T01:00:00.000Z");
    expect(isAttributionWindowClosed(decidedAt, "CAPTURE", oneHourLater)).toBe(true); // 30 min window
    expect(isAttributionWindowClosed(decidedAt, "PAYMENT_LINK", oneHourLater)).toBe(false); // 24h window
  });

  it("uses the default window when no strategy applies (natural-recovery-only candidates)", () => {
    const justUnderADay = new Date(decidedAt.getTime() + (DEFAULT_ATTRIBUTION_POLICY.defaultWindowMinutes - 1) * 60_000);
    const justOverADay = new Date(decidedAt.getTime() + (DEFAULT_ATTRIBUTION_POLICY.defaultWindowMinutes + 1) * 60_000);
    expect(isAttributionWindowClosed(decidedAt, null, justUnderADay)).toBe(false);
    expect(isAttributionWindowClosed(decidedAt, null, justOverADay)).toBe(true);
  });
});
