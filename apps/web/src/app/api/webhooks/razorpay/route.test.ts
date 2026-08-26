import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ingestMock = vi.fn();

// The route only needs to know whether ingestion accepted or deduped the
// event - it doesn't need a real database, so we mock the idempotency
// layer entirely and assert on how the route calls it.
vi.mock("@/lib/webhooks/idempotency", () => ({
  ingestPaymentEventIdempotently: ingestMock,
}));

// `next/server`'s `after()` requires a real request scope set up by Next's
// server runtime, which isn't present when a route handler is invoked
// directly (as these tests do). Keep NextRequest/NextResponse real; only
// stand in for `after` by running its callback immediately.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: (callback: () => void) => callback() };
});

// The route's `after()` callback (in processing/queue.ts) calls into the
// recovery engine, which needs a real database - mock it here so this
// route-contract test suite stays fast and DB-independent. The recovery
// pipeline itself is tested in candidateBuilder.test.ts.
vi.mock("@/lib/recovery/candidateBuilder", () => ({
  buildRecoveryCandidateFromPaymentEvent: vi.fn().mockResolvedValue({ status: "skipped_not_found" }),
}));

const { POST } = await import("./route");

const SECRET = "route_test_secret";
const BODY = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_XYZ", amount: 12345 } } },
});

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function makeRequest(opts: {
  body: string;
  signature?: string | null;
  eventId?: string | null;
}) {
  const headers = new Headers();
  if (opts.signature !== null) {
    headers.set("x-razorpay-signature", opts.signature ?? sign(opts.body, SECRET));
  }
  if (opts.eventId !== undefined && opts.eventId !== null) {
    headers.set("x-razorpay-event-id", opts.eventId);
  }
  return new NextRequest("http://localhost/api/webhooks/razorpay", {
    method: "POST",
    body: opts.body,
    headers,
  });
}

describe("POST /api/webhooks/razorpay", () => {
  const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  beforeEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;
    ingestMock.mockReset();
    ingestMock.mockResolvedValue({ status: "accepted", paymentEventId: "evt_1" });
  });

  afterEach(() => {
    process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
  });

  it("uses the x-razorpay-event-id header as the idempotency key", async () => {
    const request = makeRequest({ body: BODY, eventId: "evt_unique_delivery_id" });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(ingestMock.mock.calls[0][0]).toMatchObject({
      razorpayEventId: "evt_unique_delivery_id",
      eventType: "payment.captured",
    });
  });

  it("returns 200 for a fresh event and 200 again for a retried duplicate delivery", async () => {
    ingestMock.mockResolvedValueOnce({ status: "accepted", paymentEventId: "evt_1" });
    const first = await POST(makeRequest({ body: BODY, eventId: "evt_retry_1" }));
    expect(first.status).toBe(200);
    expect((await first.json()).status).toBe("accepted");

    ingestMock.mockResolvedValueOnce({
      status: "duplicate",
      razorpayEventId: "evt_retry_1",
    });
    const retry = await POST(makeRequest({ body: BODY, eventId: "evt_retry_1" }));
    expect(retry.status).toBe(200);
    expect((await retry.json()).status).toBe("duplicate");
  });

  it("rejects with 401 when the signature is invalid, without ingesting", async () => {
    const request = makeRequest({
      body: BODY,
      signature: "0".repeat(64),
      eventId: "evt_should_not_be_ingested",
    });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("fails closed with 401 when the webhook secret is not configured", async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const request = makeRequest({ body: BODY, eventId: "evt_no_secret" });

    const response = await POST(request);

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.reason).toBe("missing_webhook_secret");
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects with 401 when the signature header is missing", async () => {
    const request = makeRequest({ body: BODY, signature: null, eventId: "evt_no_sig" });

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed signature header with 401 instead of throwing", async () => {
    const request = makeRequest({
      body: BODY,
      signature: "totally-not-hex",
      eventId: "evt_malformed_sig",
    });

    await expect(POST(request)).resolves.toBeDefined();
    const response = await POST(
      makeRequest({ body: BODY, signature: "totally-not-hex", eventId: "evt_malformed_sig" })
    );
    expect(response.status).toBe(401);
    expect(ingestMock).not.toHaveBeenCalled();
  });

  it("returns 500 (so Razorpay retries) on a genuine database failure, without crashing", async () => {
    ingestMock.mockRejectedValueOnce(new Error("connection refused"));
    const request = makeRequest({ body: BODY, eventId: "evt_db_failure" });

    const response = await POST(request);

    expect(response.status).toBe(500);
    const json = await response.json();
    expect(json.error).toBe("database_failure");
  });
});
