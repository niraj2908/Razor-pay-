import { describe, expect, it } from "vitest";
import { estimateInterventionResponse } from "./interventionResponseModel";
import { estimateNaturalRecovery } from "./naturalRecoveryModel";
import { RecoveryContext } from "./types";

const BASE_CONTEXT: RecoveryContext = {
  paymentId: "pay_1",
  merchantId: "merchant_1",
  amount: 10000,
  paymentMethod: "card",
  paymentState: "failed",
  failureReason: "CUSTOMER_ABANDONMENT",
  retryCount: 0,
  minutesSinceLastAttempt: 120,
  customerContactCount: 0,
  hasPendingExecution: false,
  activeIncident: false,
};

describe("estimateInterventionResponse", () => {
  it("is never lower than the natural recovery probability for the same context", () => {
    const natural = estimateNaturalRecovery(BASE_CONTEXT);
    const withRetry = estimateInterventionResponse(BASE_CONTEXT, "RETRY");
    const withLink = estimateInterventionResponse(BASE_CONTEXT, "PAYMENT_LINK");
    expect(withRetry.probability).toBeGreaterThanOrEqual(natural.probability);
    expect(withLink.probability).toBeGreaterThanOrEqual(natural.probability);
  });

  it("stays within [0,1] even when uplift would push it over 1", () => {
    const nearCertain = { ...BASE_CONTEXT, failureReason: "NETWORK_DEGRADATION" as const };
    const result = estimateInterventionResponse(nearCertain, "RETRY");
    expect(result.probability).toBeLessThanOrEqual(1);
  });

  it("gives PAYMENT_LINK a bigger uplift than RETRY for customer abandonment", () => {
    const retry = estimateInterventionResponse(BASE_CONTEXT, "RETRY");
    const link = estimateInterventionResponse(BASE_CONTEXT, "PAYMENT_LINK");
    expect(link.probability).toBeGreaterThan(retry.probability);
  });

  it("gives RETRY a bigger uplift than PAYMENT_LINK for network degradation", () => {
    const context = { ...BASE_CONTEXT, failureReason: "NETWORK_DEGRADATION" as const };
    const retry = estimateInterventionResponse(context, "RETRY");
    const link = estimateInterventionResponse(context, "PAYMENT_LINK");
    expect(retry.probability).toBeGreaterThan(link.probability);
  });

  it("tags results with the intervention model version, distinct from the natural model", () => {
    const result = estimateInterventionResponse(BASE_CONTEXT, "RETRY");
    expect(result.modelVersion).toBe("intervention-baseline-v1");
  });
});
