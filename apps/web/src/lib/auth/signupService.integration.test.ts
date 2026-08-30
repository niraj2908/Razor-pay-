import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { signUpNewWorkspace } from "./signupService";
import { createOperatorSession, resolveOperatorSession } from "./authService";
import { authorizeMerchantAccess, resolveMerchantAccess } from "./merchantAccess";

/**
 * Real-database integration tests for public self-signup - proves what
 * the unit tests (mocked Prisma) structurally cannot: real Postgres
 * transaction rollback under a genuine concurrent-duplicate-email race,
 * and that a session issued at signup resolves to exactly the
 * just-created Merchant against two REAL, distinct Merchant rows, not a
 * mocked assertion. Mirrors the exact tag/cleanup convention already
 * established in merchantAccess.integration.test.ts.
 */
const TAG = `phase26-signup-${randomUUID()}`;
const createdMerchantIds: string[] = [];

afterEach(async () => {
  // Cascades delete each Merchant's Operators/Sessions too (schema.prisma:
  // onDelete: Cascade on both relations) - a single cleanup step per test.
  if (createdMerchantIds.length > 0) {
    await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
    createdMerchantIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("signUpNewWorkspace against a real database", () => {
  it("creates exactly one real Merchant and one real Operator, correctly linked", async () => {
    const email = `${TAG}-single@example.com`;
    const result = await signUpNewWorkspace(email, "a-real-password", `Workspace ${TAG}`);
    expect(result.status).toBe("created");
    if (result.status !== "created") return;
    createdMerchantIds.push(result.merchantId);

    const merchant = await prisma.merchant.findUnique({ where: { id: result.merchantId } });
    expect(merchant).not.toBeNull();
    expect(merchant?.name).toBe(`Workspace ${TAG}`);

    const operators = await prisma.operator.findMany({ where: { merchantId: result.merchantId } });
    expect(operators).toHaveLength(1);
    expect(operators[0].email).toBe(email);
  }, 30_000);

  it("CRITICAL: a concurrent duplicate-email signup race leaves exactly one Merchant, never an orphan", async () => {
    const email = `${TAG}-race@example.com`;

    const [first, second] = await Promise.all([
      signUpNewWorkspace(email, "password-one", `Workspace A ${TAG}`),
      signUpNewWorkspace(email, "password-two", `Workspace B ${TAG}`),
    ]);

    const outcomes = [first, second].map((r) => r.status).sort();
    expect(outcomes).toEqual(["created", "email_already_exists"]);

    const winner = first.status === "created" ? first : second;
    if (winner.status === "created") {
      createdMerchantIds.push(winner.merchantId);
    }

    // The real assertion: exactly ONE Operator for this email exists, and
    // exactly ONE Merchant was left behind for this test's tag - if the
    // losing transaction had NOT rolled back its Merchant insert, this
    // count would be 2.
    const operatorsForEmail = await prisma.operator.findMany({ where: { email } });
    expect(operatorsForEmail).toHaveLength(1);

    const merchantsForTag = await prisma.merchant.findMany({ where: { name: { in: [`Workspace A ${TAG}`, `Workspace B ${TAG}`] } } });
    expect(merchantsForTag).toHaveLength(1);
  }, 30_000);

  it("a session issued at signup resolves to exactly the newly-created Merchant, not any other real one", async () => {
    const emailA = `${TAG}-isolation-a@example.com`;
    const resultA = await signUpNewWorkspace(emailA, "a-real-password", `Isolation Workspace A ${TAG}`);
    expect(resultA.status).toBe("created");
    if (resultA.status !== "created") return;
    createdMerchantIds.push(resultA.merchantId);

    // A second, real, unrelated signup - the actual cross-tenant leak this
    // proves is impossible.
    const emailB = `${TAG}-isolation-b@example.com`;
    const resultB = await signUpNewWorkspace(emailB, "a-real-password", `Isolation Workspace B ${TAG}`);
    expect(resultB.status).toBe("created");
    if (resultB.status !== "created") return;
    createdMerchantIds.push(resultB.merchantId);

    const session = await createOperatorSession(resultA.operator.id);
    const resolved = await resolveOperatorSession(session.token);
    expect(resolved?.operator.id).toBe(resultA.operator.id);

    expect(await resolveMerchantAccess(resultA.operator.id)).toEqual({ merchantId: resultA.merchantId });
    expect(await authorizeMerchantAccess(resultA.operator.id, resultA.merchantId)).toEqual({
      authorized: true,
      merchantId: resultA.merchantId,
    });
    // CRITICAL: operator A must never be authorized against merchant B,
    // the real, distinct workspace created moments earlier.
    expect(await authorizeMerchantAccess(resultA.operator.id, resultB.merchantId)).toEqual({ authorized: false });
  }, 30_000);
});
