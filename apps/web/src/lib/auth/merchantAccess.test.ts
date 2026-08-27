import { beforeEach, describe, expect, it, vi } from "vitest";

const operatorFindUnique = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { operator: { findUnique: operatorFindUnique } },
}));

const { resolveMerchantAccess, authorizeMerchantAccess } = await import("./merchantAccess");

describe("merchantAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("resolveMerchantAccess", () => {
    it("returns the operator's own merchantId", async () => {
      operatorFindUnique.mockResolvedValue({ merchantId: "merchant_1" });
      expect(await resolveMerchantAccess("operator_1")).toEqual({ merchantId: "merchant_1" });
      expect(operatorFindUnique).toHaveBeenCalledWith({ where: { id: "operator_1" }, select: { merchantId: true } });
    });

    it("returns null when the operator id does not resolve to a real row", async () => {
      operatorFindUnique.mockResolvedValue(null);
      expect(await resolveMerchantAccess("operator_does_not_exist")).toBeNull();
    });
  });

  describe("authorizeMerchantAccess", () => {
    it("authorizes when the requested merchant matches the operator's own merchant", async () => {
      operatorFindUnique.mockResolvedValue({ merchantId: "merchant_1" });
      expect(await authorizeMerchantAccess("operator_1", "merchant_1")).toEqual({ authorized: true, merchantId: "merchant_1" });
    });

    it("rejects when the requested merchant is a DIFFERENT merchant than the operator's own - the core cross-tenant guard", async () => {
      operatorFindUnique.mockResolvedValue({ merchantId: "merchant_1" });
      expect(await authorizeMerchantAccess("operator_1", "merchant_2")).toEqual({ authorized: false });
    });

    it("rejects uniformly (same shape) when the operator does not resolve at all - never distinguishable from a wrong-merchant rejection", async () => {
      operatorFindUnique.mockResolvedValue(null);
      const result = await authorizeMerchantAccess("operator_does_not_exist", "merchant_1");
      expect(result).toEqual({ authorized: false });
      expect(Object.keys(result)).toEqual(["authorized"]); // never leaks a merchantId on a false result
    });
  });
});
