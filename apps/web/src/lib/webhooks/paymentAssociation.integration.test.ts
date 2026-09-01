import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { associatePaymentEvent } from "./paymentAssociation";

/**
 * Real-database integration tests for Phase 23 Step 3 PaymentEvent ->
 * Payment association: concurrency and out-of-order-event behavior can
 * only be proven against a real Postgres instance (a mocked Prisma client
 * can only show our own code reacts correctly to a *simulated* race, not
 * that the actual database enforces it). Run via `pnpm test:integration`,
 * never as part of the default `pnpm test`.
 *
 * All rows are clearly-marked fixtures, cleaned up in afterAll. The 7
 * existing Test Mode webhook fixtures are never touched or read.
 */

const TAG = `phase23-step3-${randomUUID()}`;
const createdMerchantIds: string[] = [];

function paymentLinkPaidEnvelope(paymentLinkId: string, razorpayPaymentId: string, amount: number) {
  return {
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: paymentLinkId } },
      payment: { entity: { id: razorpayPaymentId, amount, currency: "INR", status: "captured" } },
    },
  };
}

function lifecycleEventEnvelope(eventType: string, razorpayPaymentId: string, status: string) {
  return {
    event: eventType,
    payload: { payment: { entity: { id: razorpayPaymentId, status } } },
  };
}

function failedEventEnvelope(razorpayPaymentId: string, amount: number) {
  // Shaped exactly like Razorpay's payment.failed entity, including the four
  // error fields the Decision Engine now diagnoses from.
  return {
    event: "payment.failed",
    payload: {
      payment: {
        entity: {
          id: razorpayPaymentId,
          amount,
          currency: "INR",
          status: "failed",
          method: "card",
          error_code: "BAD_REQUEST_ERROR",
          error_description: "Payment processing failed because of incorrect OTP",
          error_source: "customer",
          error_step: "payment_authentication",
          error_reason: "payment_authentication_failed",
        },
      },
    },
  };
}

async function makeRecoverySetup() {
  const merchant = await prisma.merchant.create({ data: { name: `Assoc test merchant ${TAG}` } });
  createdMerchantIds.push(merchant.id);

  const originalPayment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount: 10000, currency: "INR", status: "FAILED" },
  });

  const riskEvent = await prisma.revenueRiskEvent.create({
    data: {
      merchantId: merchant.id,
      paymentId: originalPayment.id,
      diagnosis: "CUSTOMER_ABANDONMENT",
      amountAtRisk: 10000,
      dataSource: "SIMULATED",
    },
  });

  const decision = await prisma.decision.create({
    data: { revenueRiskEventId: riskEvent.id, decisionType: "ACT", expectedIncrementalValue: 50 },
  });

  const paymentLinkId = `plink_${randomUUID().slice(0, 12)}`;
  const execution = await prisma.execution.create({
    data: {
      decisionId: decision.id,
      paymentId: originalPayment.id,
      actionType: "PAYMENT_LINK",
      status: "SUCCEEDED",
      razorpayReferenceId: paymentLinkId,
    },
  });

  return { merchantId: merchant.id, originalPaymentId: originalPayment.id, executionId: execution.id, paymentLinkId };
}

afterAll(async () => {
  // AuditEvent rows are never given a merchantId by paymentAssociation.ts's
  // audit() helper, so merchant-cascade deletion never reaches them -
  // they must be deleted explicitly, by the entityId of the PaymentEvents
  // and Executions this test created, BEFORE those rows are deleted.
  const eventsToClean = await prisma.paymentEvent.findMany({
    where: { payment: { merchantId: { in: createdMerchantIds } } },
    select: { id: true },
  });
  const executionsToClean = await prisma.execution.findMany({
    where: { payment: { merchantId: { in: createdMerchantIds } } },
    select: { id: true },
  });
  await prisma.auditEvent.deleteMany({
    where: {
      entityId: { in: [...eventsToClean.map((e) => e.id), ...executionsToClean.map((e) => e.id)] },
    },
  });

  await prisma.execution.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.decision.deleteMany({ where: { revenueRiskEvent: { merchantId: { in: createdMerchantIds } } } });
  await prisma.revenueRiskEvent.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.paymentEvent.deleteMany({ where: { payment: { merchantId: { in: createdMerchantIds } } } });
  await prisma.payment.deleteMany({ where: { merchantId: { in: createdMerchantIds } } });
  await prisma.merchant.deleteMany({ where: { id: { in: createdMerchantIds } } });
  await prisma.$disconnect();
});

describe("associatePaymentEvent against a real database", () => {
  it(
    "converges on exactly one new recovered Payment under 5 concurrent workers processing the same PaymentEvent",
    async () => {
      const setup = await makeRecoverySetup();
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const paymentEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-concurrent`,
          eventType: "payment_link.paid",
          payload: paymentLinkPaidEnvelope(setup.paymentLinkId, razorpayPaymentId, 10000),
        },
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, () => associatePaymentEvent(paymentEvent.id))
      );

      for (const result of results) {
        expect(result.status).toBe("associated_new_recovered_payment");
      }

      const matchingPayments = await prisma.payment.findMany({ where: { razorpayPaymentId } });
      expect(matchingPayments).toHaveLength(1); // exactly one - no duplicate

      const finalEvent = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: paymentEvent.id } });
      expect(finalEvent.paymentId).toBe(matchingPayments[0].id);

      const finalExecution = await prisma.execution.findUniqueOrThrow({ where: { id: setup.executionId } });
      expect(finalExecution.recoveredPaymentId).toBe(matchingPayments[0].id);
    },
    20_000
  );

  it(
    "processing the same PaymentEvent twice (sequentially) never creates a duplicate Payment",
    async () => {
      const setup = await makeRecoverySetup();
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const paymentEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-duplicate`,
          eventType: "payment_link.paid",
          payload: paymentLinkPaidEnvelope(setup.paymentLinkId, razorpayPaymentId, 10000),
        },
      });

      const first = await associatePaymentEvent(paymentEvent.id);
      const second = await associatePaymentEvent(paymentEvent.id);

      expect(first.status).toBe("associated_new_recovered_payment");
      expect(second).toEqual({
        status: "already_associated",
        paymentId: (first as { paymentId: string }).paymentId,
      });

      const matchingPayments = await prisma.payment.findMany({ where: { razorpayPaymentId } });
      expect(matchingPayments).toHaveLength(1);
    },
    20_000
  );

  it(
    "a payment.authorized event arriving AFTER payment.captured never regresses the Payment's status",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Assoc test merchant ${TAG}` } });
      createdMerchantIds.push(merchant.id);
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const payment = await prisma.payment.create({
        data: { merchantId: merchant.id, razorpayPaymentId, amount: 10000, currency: "INR", status: "AUTHORIZED" },
      });

      const capturedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-captured`,
          eventType: "payment.captured",
          payload: lifecycleEventEnvelope("payment.captured", razorpayPaymentId, "captured"),
        },
      });
      await associatePaymentEvent(capturedEvent.id);

      const afterCapture = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(afterCapture.status).toBe("CAPTURED");

      // A delayed/out-of-order payment.authorized for the SAME payment arrives next.
      const lateAuthorizedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-late-authorized`,
          eventType: "payment.authorized",
          payload: lifecycleEventEnvelope("payment.authorized", razorpayPaymentId, "authorized"),
        },
      });
      const result = await associatePaymentEvent(lateAuthorizedEvent.id);

      expect(result.status).toBe("associated_existing"); // still associated...
      const afterLateEvent = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(afterLateEvent.status).toBe("CAPTURED"); // ...but never downgraded back to AUTHORIZED
    },
    20_000
  );

  it(
    "events arriving in normal order (authorized then captured) progress the status correctly",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Assoc test merchant ${TAG}` } });
      createdMerchantIds.push(merchant.id);
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const payment = await prisma.payment.create({
        data: { merchantId: merchant.id, razorpayPaymentId, amount: 10000, currency: "INR", status: "CREATED" },
      });

      const authorizedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-authorized`,
          eventType: "payment.authorized",
          payload: lifecycleEventEnvelope("payment.authorized", razorpayPaymentId, "authorized"),
        },
      });
      await associatePaymentEvent(authorizedEvent.id);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("AUTHORIZED");

      const capturedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-then-captured`,
          eventType: "payment.captured",
          payload: lifecycleEventEnvelope("payment.captured", razorpayPaymentId, "captured"),
        },
      });
      await associatePaymentEvent(capturedEvent.id);
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("CAPTURED");
    },
    20_000
  );
});

/**
 * Real-database integration tests for Phase 25's new-Payment-creation path
 * inside associateExistingPayment/findOrCreatePayment (payment.authorized/
 * failed/captured/order.paid, when no matching Payment exists yet). The
 * critical claim under test - that a brand-new Payment is created under
 * exactly the RAZORPAY_MERCHANT_ID-configured Merchant and NEVER any other
 * real Merchant, even when one exists - can only be proven against a real
 * database with two genuinely distinct Merchant rows; a mocked Prisma
 * client only proves our own code reacts correctly to a simulated row.
 */
describe("associatePaymentEvent - new Payment creation against a real database", () => {
  const originalValue = process.env.RAZORPAY_MERCHANT_ID;
  const createdForCreationTests: string[] = [];
  const createdPaymentEventIds: string[] = [];

  function newPaymentEnvelope(razorpayPaymentId: string, amount: number, status = "captured") {
    return { event: "payment.captured", payload: { payment: { entity: { id: razorpayPaymentId, amount, currency: "INR", status } } } };
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
    // Explicit by-id cleanup (not just "events attached to these merchants'
    // payments") - the fail-closed test's PaymentEvent is deliberately NEVER
    // associated to any Payment, so it would otherwise be orphaned here.
    await prisma.paymentEvent.deleteMany({ where: { id: { in: createdPaymentEventIds } } });
    await prisma.payment.deleteMany({ where: { merchantId: { in: createdForCreationTests } } });
    await prisma.merchant.deleteMany({ where: { id: { in: createdForCreationTests } } });
    await prisma.$disconnect();
  });

  it(
    "creates a new Payment under the configured Merchant, and never under a second real Merchant that also exists",
    async () => {
      const configuredMerchant = await prisma.merchant.create({ data: { name: `Creation test configured merchant ${TAG}` } });
      const otherMerchant = await prisma.merchant.create({ data: { name: `Creation test OTHER merchant ${TAG}` } });
      createdForCreationTests.push(configuredMerchant.id, otherMerchant.id);
      process.env.RAZORPAY_MERCHANT_ID = configuredMerchant.id;

      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const paymentEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-new-payment`,
          eventType: "payment.captured",
          payload: newPaymentEnvelope(razorpayPaymentId, 15000),
        },
      });
      createdPaymentEventIds.push(paymentEvent.id);

      const result = await associatePaymentEvent(paymentEvent.id);

      expect(result.status).toBe("associated_new_payment");
      const created = await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId } });
      expect(created.merchantId).toBe(configuredMerchant.id);
      expect(created.merchantId).not.toBe(otherMerchant.id);
      expect(created.amount).toBe(15000);
      expect(created.status).toBe("CAPTURED");

      const finalEvent = await prisma.paymentEvent.findUniqueOrThrow({ where: { id: paymentEvent.id } });
      expect(finalEvent.paymentId).toBe(created.id);
    },
    20_000
  );

  it(
    "fails closed - creates NO Payment at all - when RAZORPAY_MERCHANT_ID is unset, even though a real Merchant exists",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Creation test unconfigured merchant ${TAG}` } });
      createdForCreationTests.push(merchant.id);
      // RAZORPAY_MERCHANT_ID deliberately left unset by beforeEach.

      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const paymentEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-no-merchant-configured`,
          eventType: "payment.captured",
          payload: newPaymentEnvelope(razorpayPaymentId, 15000),
        },
      });
      createdPaymentEventIds.push(paymentEvent.id);

      const result = await associatePaymentEvent(paymentEvent.id);

      expect(result).toEqual({ status: "unassociated", reason: "merchant_not_configured" });
      const shouldNotExist = await prisma.payment.findUnique({ where: { razorpayPaymentId } });
      expect(shouldNotExist).toBeNull();
    },
    20_000
  );

  it(
    "5 concurrent deliveries of the same brand-new razorpayPaymentId converge on exactly one real Payment row",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Creation test concurrency merchant ${TAG}` } });
      createdForCreationTests.push(merchant.id);
      process.env.RAZORPAY_MERCHANT_ID = merchant.id;

      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      // Real, distinct PaymentEvent rows (not 5 calls on one event) - this
      // proves the real Payment.razorpayPaymentId unique constraint itself
      // prevents a duplicate, independent of PaymentEvent-level idempotency.
      const events = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          prisma.paymentEvent.create({
            data: {
              razorpayEventId: `${TAG}-concurrent-new-${i}`,
              eventType: "payment.captured",
              payload: newPaymentEnvelope(razorpayPaymentId, 20000),
            },
          })
        )
      );
      createdPaymentEventIds.push(...events.map((e) => e.id));

      const results = await Promise.all(events.map((e) => associatePaymentEvent(e.id)));

      for (const result of results) {
        expect(["associated_new_payment", "associated_existing"]).toContain(result.status);
      }
      const matchingPayments = await prisma.payment.findMany({ where: { razorpayPaymentId } });
      expect(matchingPayments).toHaveLength(1); // exactly one - no duplicate despite 5 concurrent creators
      expect(matchingPayments[0].merchantId).toBe(merchant.id);
    },
    20_000
  );

  it(
    "persists Razorpay's failure signals from a payment.failed event onto the Payment",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Assoc test merchant ${TAG}` } });
      createdMerchantIds.push(merchant.id);
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const payment = await prisma.payment.create({
        data: { merchantId: merchant.id, razorpayPaymentId, amount: 250000, currency: "INR", status: "CREATED" },
      });
      expect(payment.errorReason).toBeNull();

      const failedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-failed-signals`,
          eventType: "payment.failed",
          payload: failedEventEnvelope(razorpayPaymentId, 250000),
        },
      });
      createdPaymentEventIds.push(failedEvent.id);

      await associatePaymentEvent(failedEvent.id);

      const updated = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(updated.status).toBe("FAILED");
      expect(updated.errorCode).toBe("BAD_REQUEST_ERROR");
      expect(updated.errorReason).toBe("payment_authentication_failed");
      expect(updated.errorSource).toBe("customer");
      expect(updated.errorStep).toBe("payment_authentication");
    },
    20_000
  );

  it(
    "a later success event carries no error fields and must never blank the recorded failure",
    async () => {
      const merchant = await prisma.merchant.create({ data: { name: `Assoc test merchant ${TAG}` } });
      createdMerchantIds.push(merchant.id);
      const razorpayPaymentId = `pay_${randomUUID().slice(0, 12)}`;
      const payment = await prisma.payment.create({
        data: { merchantId: merchant.id, razorpayPaymentId, amount: 250000, currency: "INR", status: "CREATED" },
      });

      const failedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-failed-then-captured-failed`,
          eventType: "payment.failed",
          payload: failedEventEnvelope(razorpayPaymentId, 250000),
        },
      });
      createdPaymentEventIds.push(failedEvent.id);
      await associatePaymentEvent(failedEvent.id);

      const capturedEvent = await prisma.paymentEvent.create({
        data: {
          razorpayEventId: `${TAG}-failed-then-captured-captured`,
          eventType: "payment.captured",
          payload: lifecycleEventEnvelope("payment.captured", razorpayPaymentId, "captured"),
        },
      });
      createdPaymentEventIds.push(capturedEvent.id);
      await associatePaymentEvent(capturedEvent.id);

      const updated = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(updated.status).toBe("CAPTURED"); // status still moves forward
      expect(updated.errorReason).toBe("payment_authentication_failed"); // the failure is still on record
      expect(updated.errorSource).toBe("customer");
    },
    20_000
  );
});
