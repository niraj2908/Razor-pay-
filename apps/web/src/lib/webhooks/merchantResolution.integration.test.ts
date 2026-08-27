import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { resolveConfiguredMerchant } from "./merchantResolution";

/**
 * Real-database integration test for the single-Razorpay-account merchant
 * binding. A mocked Prisma client can only prove our own code reacts
 * correctly to a *simulated* Merchant row - it cannot prove that, with TWO
 * real, distinct Merchant rows genuinely present in the database, the
 * resolver still selects only the one named by configuration and never the
 * other (no accidental "first row"/count-based fallback).
 *
 * Run via `pnpm test:integration`, never as part of `pnpm test`.
 */

const TAG = `phase25-merchant-resolution-${randomUUID()}`;
const createdMerchantIds: string[] = [];
const originalValue = process.env.RAZORPAY_MERCHANT_ID;

async function makeMerchant(label: string) {
  const merchant = await prisma.merchant.create({ data: { name: `${label} ${TAG}` } });
  createdMerchantIds.push(merchant.id);
  return merchant;
}

beforeEach(() => {
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

afterAll(async () => {
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("resolveConfiguredMerchant against a real database with two real Merchants", () => {
  it("resolves exactly the configured Merchant and never the other real Merchant", async () => {
    const merchantA = await makeMerchant("Configured merchant A");
    const merchantB = await makeMerchant("Other real merchant B");
    process.env.RAZORPAY_MERCHANT_ID = merchantA.id;

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "resolved", merchantId: merchantA.id });
    expect(result).not.toEqual({ status: "resolved", merchantId: merchantB.id });
  });

  it("fails closed (unresolvable) when configured with an id matching NEITHER real Merchant - never falls back to either one", async () => {
    await makeMerchant("Real merchant A");
    await makeMerchant("Real merchant B");
    process.env.RAZORPAY_MERCHANT_ID = `${TAG}-does-not-exist`;

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "unresolvable" });
  });

  it("fails closed (not_configured) when unset, even with two real Merchants present - never picks 'the only other one' or 'the first one'", async () => {
    await makeMerchant("Real merchant A");
    await makeMerchant("Real merchant B");
    // RAZORPAY_MERCHANT_ID deliberately left unset by beforeEach.

    const result = await resolveConfiguredMerchant();

    expect(result).toEqual({ status: "not_configured" });
  });
});
