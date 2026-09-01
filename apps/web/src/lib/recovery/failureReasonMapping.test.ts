import { describe, expect, it } from "vitest";
import { mapRazorpayFailureToReason, type RazorpayFailureSignals } from "./failureReasonMapping";
import { estimateNaturalRecovery } from "./naturalRecoveryModel";
import { DEFAULT_POLICY } from "./policy";

function signals(overrides: Partial<RazorpayFailureSignals> = {}): RazorpayFailureSignals {
  return { errorCode: null, errorReason: null, errorSource: null, errorStep: null, ...overrides };
}

describe("mapRazorpayFailureToReason", () => {
  it("returns STATE_UNCERTAIN when no signal is present at all (e.g. a success event)", () => {
    expect(mapRazorpayFailureToReason(signals())).toBe("STATE_UNCERTAIN");
  });

  it("treats Razorpay's literal 'NA' source and empty strings as absent, not as a value", () => {
    expect(mapRazorpayFailureToReason(signals({ errorSource: "NA", errorReason: "  " }))).toBe(
      "STATE_UNCERTAIN"
    );
  });

  describe("source-led rules (source is trusted ahead of code)", () => {
    it("maps a customer-side failure to CUSTOMER_ABANDONMENT", () => {
      expect(
        mapRazorpayFailureToReason(
          signals({
            errorSource: "customer",
            errorStep: "payment_authentication",
            errorReason: "payment_authentication_failed",
            errorCode: "BAD_REQUEST_ERROR",
          })
        )
      ).toBe("CUSTOMER_ABANDONMENT");
    });

    it("maps a business-side failure to CONFIRMED_FAILURE - the same request cannot succeed", () => {
      expect(mapRazorpayFailureToReason(signals({ errorSource: "business" }))).toBe(
        "CONFIRMED_FAILURE"
      );
    });

    it.each(["bank", "issuer"])(
      "maps a %s-side decline to OTHER_RECOVERABLE, never CONFIRMED_FAILURE",
      (source) => {
        expect(mapRazorpayFailureToReason(signals({ errorSource: source }))).toBe(
          "OTHER_RECOVERABLE"
        );
      }
    );

    it.each(["gateway", "network", "internal"])(
      "maps a %s-side failure to NETWORK_DEGRADATION",
      (source) => {
        expect(mapRazorpayFailureToReason(signals({ errorSource: source }))).toBe(
          "NETWORK_DEGRADATION"
        );
      }
    );

    it("prefers source over code: a bank-side GATEWAY_ERROR is bank-side, not network", () => {
      expect(
        mapRazorpayFailureToReason(signals({ errorSource: "bank", errorCode: "GATEWAY_ERROR" }))
      ).toBe("OTHER_RECOVERABLE");
    });
  });

  describe("fallback rules when source is absent or unrecognised", () => {
    it("uses the reason for an authentication failure", () => {
      expect(
        mapRazorpayFailureToReason(signals({ errorReason: "payment_authentication_failed" }))
      ).toBe("CUSTOMER_ABANDONMENT");
    });

    it("uses the step for an authentication failure", () => {
      expect(mapRazorpayFailureToReason(signals({ errorStep: "payment_authentication" }))).toBe(
        "CUSTOMER_ABANDONMENT"
      );
    });

    it.each(["input_validation_failed", "invalid_card"])(
      "maps reason %s to CONFIRMED_FAILURE",
      (reason) => {
        expect(mapRazorpayFailureToReason(signals({ errorReason: reason }))).toBe(
          "CONFIRMED_FAILURE"
        );
      }
    );

    it.each(["GATEWAY_ERROR", "SERVER_ERROR"])(
      "maps code %s to NETWORK_DEGRADATION when nothing more specific applies",
      (code) => {
        expect(mapRazorpayFailureToReason(signals({ errorCode: code }))).toBe(
          "NETWORK_DEGRADATION"
        );
      }
    );
  });

  describe("safety properties", () => {
    it("degrades an unrecognised code to STATE_UNCERTAIN rather than guessing", () => {
      expect(
        mapRazorpayFailureToReason(
          signals({
            errorSource: "some_source_razorpay_added_later",
            errorReason: "brand_new_reason",
            errorCode: "NEW_ERROR",
            errorStep: "new_step",
          })
        )
      ).toBe("STATE_UNCERTAIN");
    });

    it("accepts undefined fields without throwing (partial rows, older fixtures)", () => {
      const partial = {
        errorCode: undefined,
        errorReason: undefined,
        errorSource: undefined,
        errorStep: undefined,
      };
      expect(mapRazorpayFailureToReason(partial)).toBe("STATE_UNCERTAIN");
    });

    it("is case-insensitive - Razorpay's casing must not change a diagnosis", () => {
      expect(mapRazorpayFailureToReason(signals({ errorSource: "CUSTOMER" }))).toBe(
        mapRazorpayFailureToReason(signals({ errorSource: "customer" }))
      );
    });

    it("is deterministic - the same signals always produce the same diagnosis", () => {
      const input = signals({ errorSource: "gateway", errorCode: "GATEWAY_ERROR" });
      const results = new Set(Array.from({ length: 5 }, () => mapRazorpayFailureToReason(input)));
      expect(results.size).toBe(1);
    });
  });

  describe("the confidence threshold this mapping exists to clear", () => {
    // The point of the mapping: STATE_UNCERTAIN can never reach ACT,
    // because its confidence sits below the policy minimum. A real
    // diagnosis can. These assert the relationship rather than the
    // constants, so a policy change surfaces here rather than silently
    // re-blocking ACT.
    function confidenceFor(reason: ReturnType<typeof mapRazorpayFailureToReason>) {
      return estimateNaturalRecovery({
        paymentId: "p1",
        merchantId: "m1",
        amount: 250000,
        paymentMethod: "card",
        paymentState: "failed",
        failureReason: reason,
        retryCount: 0,
        minutesSinceLastAttempt: 9999,
        customerContactCount: 0,
        hasPendingExecution: false,
        activeIncident: false,
      }).confidence;
    }

    it("STATE_UNCERTAIN sits below the policy's minimum confidence", () => {
      expect(confidenceFor("STATE_UNCERTAIN")).toBeLessThan(DEFAULT_POLICY.minConfidence);
    });

    it("a customer-abandonment diagnosis clears it", () => {
      const reason = mapRazorpayFailureToReason(signals({ errorSource: "customer" }));
      expect(confidenceFor(reason)).toBeGreaterThanOrEqual(DEFAULT_POLICY.minConfidence);
    });
  });
});
