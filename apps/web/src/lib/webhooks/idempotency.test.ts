import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

// We mock the Prisma client singleton, not @prisma/client itself - this
// keeps the test independent of a running database or a generated Prisma
// client, while still exercising the real duplicate-detection logic in
// idempotency.ts.
vi.mock("@/lib/db", () => ({
  prisma: {
    paymentEvent: {
      create: createMock,
    },
  },
}));

const { ingestPaymentEventIdempotently } = await import("./idempotency");

/**
 * A real Prisma P2002 error is an instance of
 * `Prisma.PrismaClientKnownRequestError` carrying a `.code` property.
 * idempotency.ts detects it by `.code` alone (see its
 * `isUniqueConstraintViolation`) rather than by class identity, so a
 * plain object shaped like the real error is a faithful stand-in here -
 * it does not require a generated Prisma client to construct.
 */
function uniqueConstraintError() {
  const error = new Error(
    "Unique constraint failed on the fields: (`razorpayEventId`)"
  ) as Error & { code: string; meta: unknown; clientVersion: string };
  error.code = "P2002";
  error.clientVersion = "5.22.0";
  error.meta = { target: ["razorpayEventId"] };
  return error;
}

describe("ingestPaymentEventIdempotently", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("accepts a new event and returns its id", async () => {
    createMock.mockResolvedValue({ id: "evt_internal_1" });

    const result = await ingestPaymentEventIdempotently({
      razorpayEventId: "evt_razorpay_1",
      eventType: "payment.captured",
      payload: { hello: "world" },
    });

    expect(result).toEqual({ status: "accepted", paymentEventId: "evt_internal_1" });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0][0].data.razorpayEventId).toBe("evt_razorpay_1");
  });

  it("relies on the database's unique constraint, not a check-then-insert, for idempotency", async () => {
    // A real concurrent duplicate delivery surfaces as a Postgres unique
    // violation on the second insert attempt - Prisma reports this as a
    // P2002 error. We simulate that here rather than an application-level
    // "does it exist" check, since that check-then-insert pattern is
    // exactly the race condition this design avoids.
    createMock.mockRejectedValue(uniqueConstraintError());

    const result = await ingestPaymentEventIdempotently({
      razorpayEventId: "evt_razorpay_duplicate",
      eventType: "payment.captured",
      payload: { hello: "world" },
    });

    expect(result).toEqual({
      status: "duplicate",
      razorpayEventId: "evt_razorpay_duplicate",
    });
  });

  it("re-throws errors that are not a unique constraint violation", async () => {
    createMock.mockRejectedValue(new Error("connection refused"));

    await expect(
      ingestPaymentEventIdempotently({
        razorpayEventId: "evt_razorpay_2",
        eventType: "payment.captured",
        payload: {},
      })
    ).rejects.toThrow("connection refused");
  });
});
