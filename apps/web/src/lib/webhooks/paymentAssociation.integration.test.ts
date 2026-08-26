import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
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
