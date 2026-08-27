import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createOperator, createOperatorSession, resolveOperatorSession, revokeOperatorSession, verifyOperatorCredentials } from "./authService";

/**
 * Real-database integration test for the Phase 25 Step 2A authentication
 * service and its Phase 25 Step 2B single-merchant-operator extension.
 * Proves the actual Postgres constraints: the unique constraint on
 * Operator.email (idempotent-provisioning safety), the Operator.merchantId
 * foreign key (a real nonexistent-merchant rejection, not just a mocked
 * one), and the real OperatorSession lifecycle (create -> resolve ->
 * expire/revoke).
 *
 * Every row is tagged and cleaned up in afterAll. Run via
 * `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-step2b-${randomUUID()}`;
const createdOperatorIds: string[] = [];
let merchantId: string;

function testEmail(label: string): string {
  return `${TAG}-${label}@example.com`;
}

beforeAll(async () => {
  const merchant = await prisma.merchant.create({ data: { name: `Auth integration test merchant ${TAG}` } });
  merchantId = merchant.id;
});

afterAll(async () => {
  await prisma.operatorSession.deleteMany({ where: { operatorId: { in: createdOperatorIds } } });
  await prisma.operator.deleteMany({ where: { id: { in: createdOperatorIds } } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
  await prisma.$disconnect();
});

describe("authService against a real database", () => {
  it("creates an operator and rejects a real duplicate-email insert via the database's own unique constraint", async () => {
    const email = testEmail("dup");
    const first = await createOperator(email, "a-real-password", merchantId);
    expect(first.status).toBe("created");
    if (first.status !== "created") return;
    createdOperatorIds.push(first.operator.id);

    const second = await createOperator(email, "a-different-password", merchantId);
    expect(second).toEqual({ status: "email_already_exists" });

    const rows = await prisma.operator.findMany({ where: { email } });
    expect(rows).toHaveLength(1); // no duplicate row was created
  }, 30_000);

  it("rejects a real nonexistent merchant via the database's own foreign key constraint", async () => {
    const email = testEmail("no-merchant");
    const result = await createOperator(email, "a-real-password", "merchant_does_not_exist_at_all");
    expect(result).toEqual({ status: "merchant_not_found" });

    const rows = await prisma.operator.findMany({ where: { email } });
    expect(rows).toHaveLength(0); // no partial/orphaned row was created
  }, 30_000);

  it("verifies real credentials against the real stored scrypt hash", async () => {
    const email = testEmail("creds");
    const created = await createOperator(email, "correct-password-1", merchantId);
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    createdOperatorIds.push(created.operator.id);

    expect((await verifyOperatorCredentials(email, "correct-password-1")).status).toBe("valid");
    expect((await verifyOperatorCredentials(email, "wrong-password")).status).toBe("invalid_credentials");
    expect((await verifyOperatorCredentials(testEmail("nobody"), "anything")).status).toBe("invalid_credentials");
  }, 30_000);

  it("a real session round-trips through create -> resolve -> revoke against the real database", async () => {
    const email = testEmail("session");
    const created = await createOperator(email, "a-real-password", merchantId);
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    createdOperatorIds.push(created.operator.id);

    const session = await createOperatorSession(created.operator.id);

    const resolved = await resolveOperatorSession(session.token);
    expect(resolved?.operator.email).toBe(email);

    // The raw token is never persisted - only its hash - confirmed by
    // reading the actual row back and checking it does not equal the token.
    const row = await prisma.operatorSession.findFirst({ where: { operatorId: created.operator.id } });
    expect(row?.tokenHash).not.toBe(session.token);

    await revokeOperatorSession(session.token);
    expect(await resolveOperatorSession(session.token)).toBeNull();

    const revokedRow = await prisma.operatorSession.findUnique({ where: { id: row!.id } });
    expect(revokedRow?.revokedAt).not.toBeNull(); // revoked, never deleted - history preserved
  }, 30_000);

  it("an expired real session resolves to null even though the row still exists", async () => {
    const email = testEmail("expired");
    const created = await createOperator(email, "a-real-password", merchantId);
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    createdOperatorIds.push(created.operator.id);

    const session = await createOperatorSession(created.operator.id);
    await prisma.operatorSession.updateMany({
      where: { operatorId: created.operator.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    expect(await resolveOperatorSession(session.token)).toBeNull();
  }, 30_000);

  it("deleting the merchant cascades to delete its operators (and their sessions)", async () => {
    const cascadeMerchant = await prisma.merchant.create({ data: { name: `Cascade test merchant ${TAG}` } });
    const email = testEmail("cascade");
    const created = await createOperator(email, "a-real-password", cascadeMerchant.id);
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    const session = await createOperatorSession(created.operator.id);

    await prisma.merchant.delete({ where: { id: cascadeMerchant.id } });

    expect(await prisma.operator.findUnique({ where: { id: created.operator.id } })).toBeNull();
    expect(await resolveOperatorSession(session.token)).toBeNull();
  }, 30_000);
});
