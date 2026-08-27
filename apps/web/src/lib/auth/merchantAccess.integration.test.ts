import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createOperator } from "./authService";
import { authorizeMerchantAccess, resolveMerchantAccess } from "./merchantAccess";

/**
 * Real-database integration test for Phase 25 Step 2B's merchant
 * authorization layer - specifically proves the cross-tenant guard with
 * TWO real, distinct Merchant rows and a real Operator scoped to only one
 * of them, not just a mocked assertion.
 */

const TAG = `phase25-step2b-merchantAccess-${randomUUID()}`;
let merchantA: { id: string };
let merchantB: { id: string };
let operatorId: string;

beforeAll(async () => {
  merchantA = await prisma.merchant.create({ data: { name: `Merchant A ${TAG}` } });
  merchantB = await prisma.merchant.create({ data: { name: `Merchant B ${TAG}` } });

  const created = await createOperator(`${TAG}@example.com`, "a-real-password", merchantA.id);
  if (created.status !== "created") throw new Error("test setup failed");
  operatorId = created.operator.id;
});

afterAll(async () => {
  await prisma.operator.deleteMany({ where: { id: operatorId } });
  await prisma.merchant.deleteMany({ where: { id: { in: [merchantA.id, merchantB.id] } } });
  await prisma.$disconnect();
});

describe("merchantAccess against a real database", () => {
  it("resolves the operator's own real merchant", async () => {
    expect(await resolveMerchantAccess(operatorId)).toEqual({ merchantId: merchantA.id });
  }, 30_000);

  it("authorizes access to the operator's own merchant", async () => {
    expect(await authorizeMerchantAccess(operatorId, merchantA.id)).toEqual({ authorized: true, merchantId: merchantA.id });
  }, 30_000);

  it("CRITICAL: rejects access to a real, different merchant - the actual cross-tenant leak this layer exists to prevent", async () => {
    expect(await authorizeMerchantAccess(operatorId, merchantB.id)).toEqual({ authorized: false });
  }, 30_000);

  it("rejects for a nonexistent operator id", async () => {
    expect(await resolveMerchantAccess("operator_does_not_exist_at_all")).toBeNull();
    expect(await authorizeMerchantAccess("operator_does_not_exist_at_all", merchantA.id)).toEqual({ authorized: false });
  }, 30_000);
});
