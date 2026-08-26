import { describe, expect, it } from "vitest";
import { estimateNaturalRecovery } from "./naturalRecoveryModel";
import { RecoveryContext } from "./types";

const BASE_CONTEXT: RecoveryContext = {
  paymentId: "pay_1",
  merchantId: "merchant_1",
  amount: 10000,
  paymentMethod: "card",
  paymentState: "failed",
  failureReason: "NETWORK_DEGRADATION",
  retryCount: 0,
  minutesSinceLastAttempt: 120,
  customerContactCount: 0,
  hasPendingExecution: false,
  activeIncident: false,
};

describe("estimateNaturalRecovery", () => {
  it("returns a probability and confidence within [0,1] with expected metadata", () => {
    const result = estimateNaturalRecovery(BASE_CONTEXT);
    expect(result.probability).toBeGreaterThanOrEqual(0);
    expect(result.probability).toBeLessThanOrEqual(1);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.modelVersion).toBe("baseline-v1");
    expect(result.featureVersion).toBe("features-v1");
  });

  it("gives a confirmed failure a near-zero probability and high confidence", () => {
    const result = estimateNaturalRecovery({ ...BASE_CONTEXT, failureReason: "CONFIRMED_FAILURE" });
    expect(result.probability).toBeLessThan(0.1);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it("gives network degradation a materially higher probability than a confirmed failure", () => {
    const network = estimateNaturalRecovery({ ...BASE_CONTEXT, failureReason: "NETWORK_DEGRADATION" });
    const confirmed = estimateNaturalRecovery({ ...BASE_CONTEXT, failureReason: "CONFIRMED_FAILURE" });
    expect(network.probability).toBeGreaterThan(confirmed.probability);
  });

  it("decreases probability and confidence as retry count increases", () => {
    const first = estimateNaturalRecovery({ ...BASE_CONTEXT, retryCount: 0 });
    const later = estimateNaturalRecovery({ ...BASE_CONTEXT, retryCount: 3 });
    expect(later.probability).toBeLessThan(first.probability);
    expect(later.confidence).toBeLessThan(first.confidence);
  });

  it("never goes below zero even with many retries", () => {
    const result = estimateNaturalRecovery({ ...BASE_CONTEXT, retryCount: 50 });
    expect(result.probability).toBe(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });
});
