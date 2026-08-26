import { prisma } from "@/lib/db";

export type IngestPaymentEventInput = {
  razorpayEventId: string;
  eventType: string;
  payload: unknown;
  paymentId?: string | null;
};

export type IngestPaymentEventResult =
  | { status: "accepted"; paymentEventId: string }
  | { status: "duplicate"; razorpayEventId: string };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * Ingests a Razorpay webhook event idempotently.
 *
 * Razorpay retries webhook delivery on timeout/non-2xx responses, so the
 * same event can arrive more than once (and concurrently, if a previous
 * delivery is still being processed when a retry lands). Idempotency must
 * therefore come from the database, not the application:
 *
 * We rely on the UNIQUE constraint on `PaymentEvent.razorpayEventId` and
 * simply attempt an insert. If a duplicate arrives - even from a
 * concurrent request - Postgres itself rejects the second insert and
 * Prisma surfaces it as error code P2002, which we translate into a
 * "duplicate" result.
 *
 * We deliberately do NOT do a "check if it exists, then insert" - that
 * has a race window between the check and the insert where two concurrent
 * deliveries of the same event can both pass the check and both insert,
 * defeating idempotency. A single insert guarded by the DB constraint has
 * no such window.
 */
export async function ingestPaymentEventIdempotently(
  input: IngestPaymentEventInput
): Promise<IngestPaymentEventResult> {
  try {
    const created = await prisma.paymentEvent.create({
      data: {
        razorpayEventId: input.razorpayEventId,
        eventType: input.eventType,
        // Webhook payloads are arbitrary external JSON from Razorpay, not a
        // shape we model further - Prisma just needs it to be JSON-safe.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: input.payload as any,
        paymentId: input.paymentId ?? null,
      },
    });

    return { status: "accepted", paymentEventId: created.id };
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return { status: "duplicate", razorpayEventId: input.razorpayEventId };
    }

    throw error;
  }
}

/**
 * Detects a Prisma "unique constraint failed" error (P2002) by its error
 * code rather than `instanceof Prisma.PrismaClientKnownRequestError`.
 *
 * Every Prisma "known request" error - regardless of exact class identity
 * across client instances, bundlers, or module duplication - carries a
 * stable `.code` property. Checking the code directly is just as precise
 * for this one well-known error code and avoids a brittle dependency on
 * class identity checks across module boundaries.
 */
function isUniqueConstraintViolation(
  error: unknown
): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PRISMA_UNIQUE_CONSTRAINT_VIOLATION
  );
}
