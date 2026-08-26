import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { ingestPaymentEventIdempotently } from "./idempotency";

/**
 * These tests hit the real Supabase Postgres database via DATABASE_URL,
 * proving idempotency is enforced by the actual DB unique constraint under
 * both sequential retries and true concurrent inserts - properties the
 * mocked tests in idempotency.test.ts cannot demonstrate on their own.
 * Run with `pnpm test:integration` (requires a reachable DATABASE_URL).
 */

const createdEventIds: string[] = [];

afterAll(async () => {
  if (createdEventIds.length > 0) {
    await prisma.paymentEvent.deleteMany({
      where: { razorpayEventId: { in: createdEventIds } },
    });
  }
  await prisma.$disconnect();
});

describe("ingestPaymentEventIdempotently (real database)", () => {
  it("delivers a unique event 3 times: 1 accepted, 2 duplicate, DB count 1", async () => {
    const razorpayEventId = `evt_integration_${randomUUID()}`;
    createdEventIds.push(razorpayEventId);

    const first = await ingestPaymentEventIdempotently({
      razorpayEventId,
      eventType: "payment.captured",
      payload: { test: "sequential-delivery" },
    });
    const second = await ingestPaymentEventIdempotently({
      razorpayEventId,
      eventType: "payment.captured",
      payload: { test: "sequential-delivery" },
    });
    const third = await ingestPaymentEventIdempotently({
      razorpayEventId,
      eventType: "payment.captured",
      payload: { test: "sequential-delivery" },
    });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    expect(third.status).toBe("duplicate");

    const count = await prisma.paymentEvent.count({ where: { razorpayEventId } });
    expect(count).toBe(1);
  });

  it("handles 5 concurrent deliveries of the same event: exactly 1 accepted, 4 duplicate", async () => {
    const razorpayEventId = `evt_integration_concurrent_${randomUUID()}`;
    createdEventIds.push(razorpayEventId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ingestPaymentEventIdempotently({
          razorpayEventId,
          eventType: "payment.captured",
          payload: { test: "concurrent-delivery" },
        })
      )
    );

    const accepted = results.filter((r) => r.status === "accepted");
    const duplicate = results.filter((r) => r.status === "duplicate");

    expect(accepted).toHaveLength(1);
    expect(duplicate).toHaveLength(4);

    const count = await prisma.paymentEvent.count({ where: { razorpayEventId } });
    expect(count).toBe(1);
  });

  it("does not mutate the existing row on a duplicate delivery", async () => {
    const razorpayEventId = `evt_integration_immutable_${randomUUID()}`;
    createdEventIds.push(razorpayEventId);

    const original = await ingestPaymentEventIdempotently({
      razorpayEventId,
      eventType: "payment.captured",
      payload: { amount: 100 },
    });
    expect(original.status).toBe("accepted");

    const before = await prisma.paymentEvent.findUniqueOrThrow({
      where: { razorpayEventId },
    });

    await ingestPaymentEventIdempotently({
      razorpayEventId,
      eventType: "payment.captured",
      payload: { amount: 999999 }, // different payload - must NOT overwrite
    });

    const after = await prisma.paymentEvent.findUniqueOrThrow({
      where: { razorpayEventId },
    });

    expect(after).toEqual(before);
  });
});
