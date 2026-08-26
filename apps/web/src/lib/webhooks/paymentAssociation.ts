import type { RazorpayPaymentStatus } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Phase 23 Step 3: deterministically links a persisted PaymentEvent to a
 * Payment row. This is the ONLY thing this module does - it never decides
 * NATURAL_RECOVERY/INTERVENTION_RECOVERY (that is Outcome attribution,
 * Phase 23 Step 4) and it is called from the processing boundary
 * (processing/queue.ts), never from the webhook route itself.
 *
 * Association rules (see docs/decision-engine.md, Phase 23 Step 1/3):
 *   1. Razorpay payment id (payload.payment.entity.id) against
 *      Payment.razorpayPaymentId - deterministic, used for
 *      payment.authorized/failed/captured/order.paid.
 *   2. Payment Link id (payload.payment_link.entity.id) against
 *      Execution.razorpayReferenceId - deterministic, used only for
 *      payment_link.paid, and is the ONLY case that creates a new Payment.
 * Amount/email/phone/timestamp/"closest payment" matching is never used -
 * if neither rule above resolves deterministically, the event is left
 * unassociated and audited as such. No relationship is ever fabricated.
 */

export type AssociationOutcome =
  | { status: "skipped_not_found" }
  | { status: "skipped_fixture" }
  | { status: "already_associated"; paymentId: string }
  | { status: "associated_existing"; paymentId: string }
  | { status: "associated_new_recovered_payment"; paymentId: string; executionId: string }
  | { status: "unassociated"; reason: string };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isUniqueConstraintViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Razorpay webhook envelopes nest the relevant entity two levels deep:
 * envelope.payload.<kind>.entity - e.g. envelope.payload.payment.entity.id.
 * `envelope` here is the full stored PaymentEvent.payload, not to be
 * confused with envelope.payload, its own nested field of the same name.
 */
function readEntity(envelope: unknown, kind: string): Record<string, unknown> | null {
  const root = asRecord(envelope);
  const innerPayload = root ? asRecord(root.payload) : null;
  const container = innerPayload ? asRecord(innerPayload[kind]) : null;
  return container ? asRecord(container.entity) : null;
}

function extractRazorpayPaymentId(envelope: unknown): string | null {
  return readString(readEntity(envelope, "payment")?.id);
}

function extractPaymentLinkId(envelope: unknown): string | null {
  return readString(readEntity(envelope, "payment_link")?.id);
}

const RAZORPAY_STATUS_MAP: Record<string, RazorpayPaymentStatus> = {
  created: "CREATED",
  authorized: "AUTHORIZED",
  captured: "CAPTURED",
  failed: "FAILED",
  refunded: "REFUNDED",
};

function mapRazorpayStatus(rawStatus: unknown): RazorpayPaymentStatus | null {
  const value = readString(rawStatus);
  return value ? RAZORPAY_STATUS_MAP[value] ?? null : null;
}

// Documented Razorpay lifecycle only (Phase 22 Step 1 research):
// created -> authorized -> captured, or -> failed; captured -> refunded.
// No documented transition ever regresses a payment out of CAPTURED/REFUNDED,
// so a late/duplicate/out-of-order event can never downgrade those states.
const STATUS_RANK: Record<RazorpayPaymentStatus, number> = {
  CREATED: 0,
  AUTHORIZED: 1,
  FAILED: 1,
  CAPTURED: 2,
  REFUNDED: 3,
};

function isStatusRegression(current: RazorpayPaymentStatus, incoming: RazorpayPaymentStatus): boolean {
  return STATUS_RANK[incoming] < STATUS_RANK[current];
}

async function audit(paymentEventId: string, action: string, details: Record<string, unknown>): Promise<void> {
  await prisma.auditEvent.create({
    data: {
      entityType: "PaymentEvent",
      entityId: paymentEventId,
      action,
      actorType: "SYSTEM",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: details as any,
    },
  });
}

/** payment.authorized / payment.failed / payment.captured / order.paid - all carry a Razorpay payment id. */
async function associateExistingPayment(
  paymentEventId: string,
  payload: unknown
): Promise<AssociationOutcome> {
  const razorpayPaymentId = extractRazorpayPaymentId(payload);
  if (!razorpayPaymentId) {
    await audit(paymentEventId, "payment_event.unassociated", { reason: "missing_razorpay_payment_id" });
    return { status: "unassociated", reason: "missing_razorpay_payment_id" };
  }

  const payment = await prisma.payment.findUnique({ where: { razorpayPaymentId } });
  if (!payment) {
    await audit(paymentEventId, "payment_event.unassociated", {
      reason: "no_existing_payment_found",
      razorpayPaymentId,
    });
    return { status: "unassociated", reason: "no_existing_payment_found" };
  }

  const incomingStatus = mapRazorpayStatus(readEntity(payload, "payment")?.status);
  if (incomingStatus && !isStatusRegression(payment.status, incomingStatus)) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: incomingStatus } });
  }

  await prisma.paymentEvent.update({ where: { id: paymentEventId }, data: { paymentId: payment.id } });
  await audit(paymentEventId, "payment_event.associated", { paymentId: payment.id, razorpayPaymentId });
  return { status: "associated_existing", paymentId: payment.id };
}

/**
 * payment_link.paid - the only event that may create a NEW Payment. The
 * Payment Link id is our deterministic correlation key back to the
 * Execution that created it (Phase 22: reference_id/razorpayReferenceId),
 * never timing or amount. The new payment is a genuinely different
 * Razorpay payment object than the one the Execution's `paymentId`
 * refers to - it is linked via the new `Execution.recoveredPaymentId`
 * field, never by overwriting the original Payment.
 */
async function associatePaymentLinkPaid(
  paymentEventId: string,
  payload: unknown
): Promise<AssociationOutcome> {
  const paymentLinkId = extractPaymentLinkId(payload);
  if (!paymentLinkId) {
    await audit(paymentEventId, "payment_event.unassociated", { reason: "missing_payment_link_id" });
    return { status: "unassociated", reason: "missing_payment_link_id" };
  }

  const execution = await prisma.execution.findFirst({ where: { razorpayReferenceId: paymentLinkId } });
  if (!execution) {
    await audit(paymentEventId, "payment_event.unassociated", {
      reason: "no_matching_execution_for_payment_link",
      paymentLinkId,
    });
    return { status: "unassociated", reason: "no_matching_execution_for_payment_link" };
  }

  const paymentEntity = readEntity(payload, "payment");
  const razorpayPaymentId = readString(paymentEntity?.id);
  if (!razorpayPaymentId) {
    await audit(paymentEventId, "payment_event.unassociated", {
      reason: "missing_razorpay_payment_id_in_payment_link_paid",
      paymentLinkId,
      executionId: execution.id,
    });
    return { status: "unassociated", reason: "missing_razorpay_payment_id_in_payment_link_paid" };
  }

  const amount = readNumber(paymentEntity?.amount);
  const currency = readString(paymentEntity?.currency) ?? "INR";
  const method = readString(paymentEntity?.method);
  const status = mapRazorpayStatus(paymentEntity?.status) ?? "CAPTURED";

  if (amount === null) {
    await audit(paymentEventId, "payment_event.unassociated", {
      reason: "missing_amount_in_payment_link_paid",
      paymentLinkId,
      executionId: execution.id,
    });
    return { status: "unassociated", reason: "missing_amount_in_payment_link_paid" };
  }

  const originalPayment = await prisma.payment.findUniqueOrThrow({ where: { id: execution.paymentId } });

  let recoveredPayment;
  try {
    recoveredPayment = await prisma.payment.create({
      data: {
        merchantId: originalPayment.merchantId, // same merchant as the payment being recovered
        razorpayPaymentId,
        amount,
        currency,
        method,
        status,
      },
    });
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      // Idempotent: a concurrent delivery (or a re-processing) already
      // created this exact Razorpay payment - use it, never create twice.
      recoveredPayment = await prisma.payment.findUniqueOrThrow({ where: { razorpayPaymentId } });
    } else {
      throw error;
    }
  }

  await prisma.paymentEvent.update({ where: { id: paymentEventId }, data: { paymentId: recoveredPayment.id } });

  // Idempotent: only set recoveredPaymentId if not already set to a
  // different value - never overwrite an existing, different link.
  if (!execution.recoveredPaymentId) {
    try {
      await prisma.execution.update({
        where: { id: execution.id },
        data: { recoveredPaymentId: recoveredPayment.id },
      });
    } catch (error) {
      // Another concurrent call already set it (or set a different
      // recoveredPaymentId for a different payment object under a race) -
      // do not fail the whole association over this; the PaymentEvent
      // linkage above is already correct and is the important part here.
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
    }
  }

  await audit(paymentEventId, "payment_event.associated_new_recovered_payment", {
    paymentId: recoveredPayment.id,
    executionId: execution.id,
    paymentLinkId,
  });

  return { status: "associated_new_recovered_payment", paymentId: recoveredPayment.id, executionId: execution.id };
}

const EXISTING_PAYMENT_EVENT_TYPES = new Set([
  "payment.authorized",
  "payment.failed",
  "payment.captured",
  "order.paid",
]);

/**
 * Entry point called from the processing boundary (processing/queue.ts),
 * never from the webhook route/response cycle. Idempotent: a PaymentEvent
 * that already has a paymentId is never reprocessed.
 */
export async function associatePaymentEvent(paymentEventId: string): Promise<AssociationOutcome> {
  const event = await prisma.paymentEvent.findUnique({ where: { id: paymentEventId } });
  if (!event) {
    return { status: "skipped_not_found" };
  }

  const payload = event.payload as { _test_fixture?: { isTestFixture?: boolean } } | null;
  if (payload?._test_fixture?.isTestFixture === true) {
    return { status: "skipped_fixture" };
  }

  if (event.paymentId) {
    return { status: "already_associated", paymentId: event.paymentId };
  }

  if (EXISTING_PAYMENT_EVENT_TYPES.has(event.eventType)) {
    return associateExistingPayment(paymentEventId, event.payload);
  }

  if (event.eventType === "payment_link.paid") {
    return associatePaymentLinkPaid(paymentEventId, event.payload);
  }

  await audit(paymentEventId, "payment_event.unassociated", { reason: "unsupported_event_type_for_association" });
  return { status: "unassociated", reason: "unsupported_event_type_for_association" };
}
