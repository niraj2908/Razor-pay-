import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveConfiguredMerchant = vi.fn();
vi.mock("./merchantResolution", () => ({ resolveConfiguredMerchant }));

const mocks = vi.hoisted(() => {
  const paymentEvents = new Map<string, { id: string; eventType: string; payload: unknown; paymentId: string | null }>();
  const payments = new Map<string, { id: string; razorpayPaymentId: string | null; status: string; merchantId: string }>();
  const executions = new Map<string, { id: string; paymentId: string; razorpayReferenceId: string | null; recoveredPaymentId: string | null }>();
  let paymentIdCounter = 0;

  const paymentEventFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => paymentEvents.get(where.id) ?? null);
  const paymentEventUpdate = vi.fn(
    async ({ where, data }: { where: { id: string }; data: { paymentId: string } }) => {
      const row = paymentEvents.get(where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    }
  );

  const paymentFindUnique = vi.fn(async ({ where }: { where: { razorpayPaymentId?: string; id?: string } }) => {
    if (where.id) return payments.get(where.id) ?? null;
    return [...payments.values()].find((p) => p.razorpayPaymentId === where.razorpayPaymentId) ?? null;
  });
  const paymentFindUniqueOrThrow = vi.fn(async ({ where }: { where: { razorpayPaymentId?: string; id?: string } }) => {
    const found = where.id
      ? payments.get(where.id)
      : [...payments.values()].find((p) => p.razorpayPaymentId === where.razorpayPaymentId);
    if (!found) throw new Error("not found");
    return found;
  });
  const paymentUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
    const row = payments.get(where.id);
    if (!row) throw new Error("not found");
    Object.assign(row, data);
    return row;
  });
  const paymentCreate = vi.fn(
    async ({ data }: { data: { merchantId: string; razorpayPaymentId: string; status: string } }) => {
      if ([...payments.values()].some((p) => p.razorpayPaymentId === data.razorpayPaymentId)) {
        const error = new Error("Unique constraint failed on the fields: (`razorpayPaymentId`)") as Error & {
          code: string;
        };
        error.code = "P2002";
        throw error;
      }
      const row = { id: `payment_${++paymentIdCounter}`, ...data };
      payments.set(row.id, row);
      return row;
    }
  );

  const executionFindFirst = vi.fn(
    async ({ where }: { where: { razorpayReferenceId: string } }) =>
      [...executions.values()].find((e) => e.razorpayReferenceId === where.razorpayReferenceId) ?? null
  );
  const executionUpdate = vi.fn(
    async ({ where, data }: { where: { id: string }; data: { recoveredPaymentId: string } }) => {
      const row = executions.get(where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    }
  );

  const auditEventCreate = vi.fn(async () => ({ id: "audit_1" }));

  return {
    paymentEvents,
    payments,
    executions,
    reset: () => {
      paymentEvents.clear();
      payments.clear();
      executions.clear();
      paymentIdCounter = 0;
    },
    paymentEventFindUnique,
    paymentEventUpdate,
    paymentFindUnique,
    paymentFindUniqueOrThrow,
    paymentUpdate,
    paymentCreate,
    executionFindFirst,
    executionUpdate,
    auditEventCreate,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    paymentEvent: { findUnique: mocks.paymentEventFindUnique, update: mocks.paymentEventUpdate },
    payment: {
      findUnique: mocks.paymentFindUnique,
      findUniqueOrThrow: mocks.paymentFindUniqueOrThrow,
      update: mocks.paymentUpdate,
      create: mocks.paymentCreate,
    },
    execution: { findFirst: mocks.executionFindFirst, update: mocks.executionUpdate },
    auditEvent: { create: mocks.auditEventCreate },
  },
}));

const { associatePaymentEvent } = await import("./paymentAssociation");

function razorpayEnvelope(eventType: string, extra: Record<string, unknown> = {}) {
  return { event: eventType, ...extra };
}

describe("associatePaymentEvent", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
    resolveConfiguredMerchant.mockResolvedValue({ status: "resolved", merchantId: "merchant_configured" });
  });

  it("skips a PaymentEvent that does not exist", async () => {
    const result = await associatePaymentEvent("evt_missing");
    expect(result).toEqual({ status: "skipped_not_found" });
  });

  it("skips a marked Test Mode fixture", async () => {
    mocks.paymentEvents.set("evt_fixture", {
      id: "evt_fixture",
      eventType: "payment.captured",
      paymentId: null,
      payload: { _test_fixture: { isTestFixture: true } },
    });

    const result = await associatePaymentEvent("evt_fixture");
    expect(result).toEqual({ status: "skipped_fixture" });
    expect(mocks.paymentFindUnique).not.toHaveBeenCalled();
  });

  it("is idempotent: a PaymentEvent already associated is never reprocessed", async () => {
    mocks.paymentEvents.set("evt_done", {
      id: "evt_done",
      eventType: "payment.captured",
      paymentId: "payment_existing",
      payload: {},
    });

    const result = await associatePaymentEvent("evt_done");
    expect(result).toEqual({ status: "already_associated", paymentId: "payment_existing" });
    expect(mocks.paymentFindUnique).not.toHaveBeenCalled();
  });

  it("associates payment.captured to an existing Payment via the Razorpay payment id", async () => {
    mocks.payments.set("payment_1", { id: "payment_1", razorpayPaymentId: "pay_abc", status: "AUTHORIZED", merchantId: "m1" });
    mocks.paymentEvents.set("evt_1", {
      id: "evt_1",
      eventType: "payment.captured",
      paymentId: null,
      payload: razorpayEnvelope("payment.captured", {
        payload: { payment: { entity: { id: "pay_abc", status: "captured" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_1");

    expect(result).toEqual({ status: "associated_existing", paymentId: "payment_1" });
    expect(mocks.paymentEvents.get("evt_1")?.paymentId).toBe("payment_1");
    expect(mocks.payments.get("payment_1")?.status).toBe("CAPTURED");
  });

  it("never regresses payment status when an older event arrives late (out-of-order events)", async () => {
    mocks.payments.set("payment_1", { id: "payment_1", razorpayPaymentId: "pay_abc", status: "CAPTURED", merchantId: "m1" });
    mocks.paymentEvents.set("evt_late_authorized", {
      id: "evt_late_authorized",
      eventType: "payment.authorized",
      paymentId: null,
      payload: razorpayEnvelope("payment.authorized", {
        payload: { payment: { entity: { id: "pay_abc", status: "authorized" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_late_authorized");

    expect(result.status).toBe("associated_existing"); // still associated...
    expect(mocks.payments.get("payment_1")?.status).toBe("CAPTURED"); // ...but status is NOT downgraded
  });

  it("leaves an event unassociated when it carries no Razorpay payment id (never amount/email/phone matching)", async () => {
    mocks.paymentEvents.set("evt_no_id", {
      id: "evt_no_id",
      eventType: "payment.captured",
      paymentId: null,
      payload: razorpayEnvelope("payment.captured", {
        payload: { payment: { entity: { amount: 10000, email: "someone@example.com" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_no_id");

    expect(result).toEqual({ status: "unassociated", reason: "missing_razorpay_payment_id" });
    expect(mocks.paymentFindUnique).not.toHaveBeenCalled();
  });

  it("creates a NEW Payment for a genuinely unseen razorpayPaymentId when the configured Merchant, amount, and status are all resolvable", async () => {
    mocks.paymentEvents.set("evt_new", {
      id: "evt_new",
      eventType: "payment.failed",
      paymentId: null,
      payload: razorpayEnvelope("payment.failed", {
        payload: { payment: { entity: { id: "pay_brand_new", amount: 25000, currency: "INR", method: "upi", status: "failed" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_new");

    expect(result.status).toBe("associated_new_payment");
    const created = [...mocks.payments.values()].find((p) => p.razorpayPaymentId === "pay_brand_new");
    expect(created).toMatchObject({ merchantId: "merchant_configured", status: "FAILED" });
    expect(mocks.paymentEvents.get("evt_new")?.paymentId).toBe(created?.id);
    expect(resolveConfiguredMerchant).toHaveBeenCalledTimes(1);
  });

  it("fails closed (never creates a Payment) when the payload has no amount for a genuinely unseen razorpayPaymentId", async () => {
    mocks.paymentEvents.set("evt_orphan", {
      id: "evt_orphan",
      eventType: "payment.failed",
      paymentId: null,
      payload: razorpayEnvelope("payment.failed", {
        payload: { payment: { entity: { id: "pay_unknown", status: "failed" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_orphan");

    expect(result).toEqual({ status: "unassociated", reason: "missing_amount_for_payment_creation" });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    expect(resolveConfiguredMerchant).not.toHaveBeenCalled(); // never even reaches merchant resolution without an amount
  });

  it("fails closed (never creates a Payment) when the incoming status is missing or unrecognized", async () => {
    mocks.paymentEvents.set("evt_bad_status", {
      id: "evt_bad_status",
      eventType: "payment.failed",
      paymentId: null,
      payload: razorpayEnvelope("payment.failed", {
        payload: { payment: { entity: { id: "pay_new_bad_status", amount: 5000, status: "some_future_razorpay_status" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_bad_status");

    expect(result).toEqual({ status: "unassociated", reason: "missing_or_unrecognized_status_for_payment_creation" });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
    expect(resolveConfiguredMerchant).not.toHaveBeenCalled();
  });

  it("fails closed (never creates a Payment) when no Merchant is configured (RAZORPAY_MERCHANT_ID unset)", async () => {
    resolveConfiguredMerchant.mockResolvedValue({ status: "not_configured" });
    mocks.paymentEvents.set("evt_no_merchant", {
      id: "evt_no_merchant",
      eventType: "payment.captured",
      paymentId: null,
      payload: razorpayEnvelope("payment.captured", {
        payload: { payment: { entity: { id: "pay_new_no_merchant", amount: 5000, status: "captured" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_no_merchant");

    expect(result).toEqual({ status: "unassociated", reason: "merchant_not_configured" });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("fails closed (never creates a Payment) when the configured Merchant id does not resolve to a real row - never falls back to any other Merchant", async () => {
    resolveConfiguredMerchant.mockResolvedValue({ status: "unresolvable" });
    mocks.paymentEvents.set("evt_bad_merchant", {
      id: "evt_bad_merchant",
      eventType: "payment.captured",
      paymentId: null,
      payload: razorpayEnvelope("payment.captured", {
        payload: { payment: { entity: { id: "pay_new_bad_merchant", amount: 5000, status: "captured" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_bad_merchant");

    expect(result).toEqual({ status: "unassociated", reason: "merchant_unresolvable" });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("converges on exactly one Payment when a concurrent delivery already created the same razorpayPaymentId first (P2002 idempotent creation)", async () => {
    // Simulates the race: paymentCreate throws P2002 as if another
    // concurrent call already inserted this exact razorpayPaymentId, so
    // this attempt must fetch and use that row rather than throwing or
    // creating a duplicate.
    mocks.payments.set("payment_race_winner", {
      id: "payment_race_winner",
      razorpayPaymentId: "pay_race",
      status: "AUTHORIZED",
      merchantId: "merchant_configured",
    });
    // Our own findUnique ran before the concurrent winner's insert - return
    // null just this once, even though the row already exists in the map
    // (the winner already committed) by the time our own create() call
    // races against it below.
    mocks.paymentFindUnique.mockResolvedValueOnce(null);
    mocks.paymentCreate.mockImplementationOnce(async () => {
      const error = new Error("Unique constraint failed on the fields: (`razorpayPaymentId`)") as Error & { code: string };
      error.code = "P2002";
      throw error;
    });

    mocks.paymentEvents.set("evt_race", {
      id: "evt_race",
      eventType: "payment.captured",
      paymentId: null,
      payload: razorpayEnvelope("payment.captured", {
        payload: { payment: { entity: { id: "pay_race", amount: 5000, status: "captured" } } },
      }),
    });

    const result = await associatePaymentEvent("evt_race");

    expect(result).toEqual({ status: "associated_existing", paymentId: "payment_race_winner" });
    expect(mocks.payments.size).toBe(1); // no duplicate Payment created
    expect(mocks.payments.get("payment_race_winner")?.status).toBe("CAPTURED"); // status still correctly advances
  });

  it("leaves payment_link.paid unassociated when no Execution matches the payment link id", async () => {
    mocks.paymentEvents.set("evt_plink_orphan", {
      id: "evt_plink_orphan",
      eventType: "payment_link.paid",
      paymentId: null,
      payload: razorpayEnvelope("payment_link.paid", {
        payload: {
          payment_link: { entity: { id: "plink_unknown" } },
          payment: { entity: { id: "pay_new", amount: 10000, currency: "INR", status: "captured" } },
        },
      }),
    });

    const result = await associatePaymentEvent("evt_plink_orphan");

    expect(result).toEqual({ status: "unassociated", reason: "no_matching_execution_for_payment_link" });
    expect(mocks.paymentCreate).not.toHaveBeenCalled();
  });

  it("creates a NEW recovered Payment for payment_link.paid, deterministically correlated via the Execution's razorpayReferenceId", async () => {
    mocks.payments.set("payment_original", {
      id: "payment_original",
      razorpayPaymentId: "pay_original_failed",
      status: "FAILED",
      merchantId: "merchant_1",
    });
    mocks.executions.set("execution_1", {
      id: "execution_1",
      paymentId: "payment_original",
      razorpayReferenceId: "plink_abc",
      recoveredPaymentId: null,
    });
    mocks.paymentEvents.set("evt_plink_paid", {
      id: "evt_plink_paid",
      eventType: "payment_link.paid",
      paymentId: null,
      payload: razorpayEnvelope("payment_link.paid", {
        payload: {
          payment_link: { entity: { id: "plink_abc" } },
          payment: { entity: { id: "pay_new_recovered", amount: 10000, currency: "INR", status: "captured" } },
        },
      }),
    });

    const result = await associatePaymentEvent("evt_plink_paid");

    expect(result.status).toBe("associated_new_recovered_payment");
    if (result.status === "associated_new_recovered_payment") {
      expect(result.executionId).toBe("execution_1");
    }
    // The new Payment is a genuinely different object under the SAME merchant.
    const newPayment = [...mocks.payments.values()].find((p) => p.razorpayPaymentId === "pay_new_recovered");
    expect(newPayment?.merchantId).toBe("merchant_1");
    expect(mocks.payments.has("payment_original")).toBe(true); // original never overwritten
    expect(mocks.executions.get("execution_1")?.recoveredPaymentId).toBe(newPayment?.id);
  });

  it("does not create a duplicate Payment when the same razorpayPaymentId already exists (idempotent, DB-unique-based)", async () => {
    mocks.payments.set("payment_original", {
      id: "payment_original",
      razorpayPaymentId: "pay_original_failed",
      status: "FAILED",
      merchantId: "merchant_1",
    });
    mocks.payments.set("payment_already_recovered", {
      id: "payment_already_recovered",
      razorpayPaymentId: "pay_new_recovered",
      status: "CAPTURED",
      merchantId: "merchant_1",
    });
    mocks.executions.set("execution_1", {
      id: "execution_1",
      paymentId: "payment_original",
      razorpayReferenceId: "plink_abc",
      recoveredPaymentId: "payment_already_recovered",
    });
    mocks.paymentEvents.set("evt_plink_paid_dup", {
      id: "evt_plink_paid_dup",
      eventType: "payment_link.paid",
      paymentId: null,
      payload: razorpayEnvelope("payment_link.paid", {
        payload: {
          payment_link: { entity: { id: "plink_abc" } },
          payment: { entity: { id: "pay_new_recovered", amount: 10000, currency: "INR", status: "captured" } },
        },
      }),
    });

    const result = await associatePaymentEvent("evt_plink_paid_dup");

    expect(result).toEqual({
      status: "associated_new_recovered_payment",
      paymentId: "payment_already_recovered",
      executionId: "execution_1",
    });
    expect(mocks.payments.size).toBe(2); // no third Payment created
  });

  it("leaves an unsupported event type unassociated", async () => {
    mocks.paymentEvents.set("evt_unknown_type", {
      id: "evt_unknown_type",
      eventType: "payment.dispute.created",
      paymentId: null,
      payload: {},
    });

    const result = await associatePaymentEvent("evt_unknown_type");
    expect(result).toEqual({ status: "unassociated", reason: "unsupported_event_type_for_association" });
  });
});
