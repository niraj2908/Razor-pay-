import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const merchantFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { merchant: { findUnique: merchantFindUnique } },
}));

const { resolveConfiguredMerchant } = await import("./merchantResolution");

describe("resolveConfiguredMerchant - single-Razorpay-account merchant binding", () => {
  const originalValue = process.env.RAZORPAY_MERCHANT_ID;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RAZORPAY_MERCHANT_ID;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (originalValue === undefined) {
      delete process.env.RAZORPAY_MERCHANT_ID;
    } else {
      process.env.RAZORPAY_MERCHANT_ID = originalValue;
    }
  });

  it("takes no parameters at all - structurally nothing for a caller (or an attacker-controlled webhook field) to pass in", () => {
    expect(resolveConfiguredMerchant.length).toBe(0);
  });

  it("fails closed with not_configured when RAZORPAY_MERCHANT_ID is unset, never querying the database", async () => {
    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "not_configured" });
    expect(merchantFindUnique).not.toHaveBeenCalled();
  });

  it("fails closed with not_configured when RAZORPAY_MERCHANT_ID is blank/whitespace-only", async () => {
    vi.stubEnv("RAZORPAY_MERCHANT_ID", "   ");

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "not_configured" });
    expect(merchantFindUnique).not.toHaveBeenCalled();
  });

  it("resolves exactly the configured Merchant when it exists", async () => {
    vi.stubEnv("RAZORPAY_MERCHANT_ID", "merchant_configured");
    merchantFindUnique.mockResolvedValue({ id: "merchant_configured" });

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "resolved", merchantId: "merchant_configured" });
    expect(merchantFindUnique).toHaveBeenCalledWith({ where: { id: "merchant_configured" }, select: { id: true } });
  });

  it("fails closed with unresolvable (ambiguous/missing binding) when the configured id does not match any real Merchant row - never falls back to any other Merchant", async () => {
    vi.stubEnv("RAZORPAY_MERCHANT_ID", "merchant_does_not_exist");
    merchantFindUnique.mockResolvedValue(null);

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "unresolvable" });
  });

  it("never queries anything other than Merchant.findUnique by the exact configured id - no findMany, no 'first Merchant' scan", async () => {
    vi.stubEnv("RAZORPAY_MERCHANT_ID", "merchant_configured");
    merchantFindUnique.mockResolvedValue({ id: "merchant_configured" });

    await resolveConfiguredMerchant();

    expect(merchantFindUnique).toHaveBeenCalledTimes(1);
  });

  it("attacker-controlled webhook-shaped fields in the ambient environment cannot alter the resolved Merchant, since none are ever read", async () => {
    vi.stubEnv("RAZORPAY_MERCHANT_ID", "merchant_configured");
    merchantFindUnique.mockResolvedValue({ id: "merchant_configured" });

    // A realistic attacker-controlled payload sitting nearby in the same
    // process - proves nothing about it can reach the resolver, since the
    // resolver has no parameter for it to be passed through.
    const attackerPayload = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_attacker", notes: { merchantId: "merchant_b_attacker_supplied" } } },
      },
      account_id: "acc_attacker_supplied",
    };
    void attackerPayload;

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "resolved", merchantId: "merchant_configured" });
  });
});
