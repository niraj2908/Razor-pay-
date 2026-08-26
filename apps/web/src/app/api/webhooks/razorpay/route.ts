import { NextRequest, NextResponse } from "next/server";
import { verifyRazorpaySignature } from "@/lib/razorpay/signature";
import { ingestPaymentEventIdempotently } from "@/lib/webhooks/idempotency";

// Signature verification needs node:crypto's timingSafeEqual, which the
// edge runtime does not provide - this route must run on the Node runtime.
export const runtime = "nodejs";

const SIGNATURE_HEADER = "x-razorpay-signature";
const EVENT_ID_HEADER = "x-razorpay-event-id";

export async function POST(request: NextRequest) {
  // Read the raw body exactly as Razorpay sent it. Signature verification
  // depends on the exact bytes that were signed - parsing/re-serializing
  // JSON before checking the signature can change the byte content and
  // break verification.
  const rawBody = await request.text();

  const signatureHeader = request.headers.get(SIGNATURE_HEADER);
  const verification = verifyRazorpaySignature(
    rawBody,
    signatureHeader,
    process.env.RAZORPAY_WEBHOOK_SECRET
  );

  if (!verification.valid) {
    console.warn("[razorpay-webhook] rejected: signature invalid", {
      reason: verification.reason,
    });
    return NextResponse.json(
      { error: "invalid_signature", reason: verification.reason },
      { status: 401 }
    );
  }

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    console.error("[razorpay-webhook] rejected: malformed JSON body");
    return NextResponse.json({ error: "malformed_body" }, { status: 400 });
  }

  const eventId = request.headers.get(EVENT_ID_HEADER);
  if (!eventId) {
    console.error("[razorpay-webhook] rejected: missing event id header");
    return NextResponse.json({ error: "missing_event_id" }, { status: 400 });
  }

  const eventType = typeof envelope.event === "string" ? envelope.event : "unknown";

  const result = await ingestPaymentEventIdempotently({
    razorpayEventId: eventId,
    eventType,
    payload: envelope,
  });

  if (result.status === "duplicate") {
    console.log("[razorpay-webhook] duplicate delivery ignored", {
      razorpayEventId: eventId,
      eventType,
    });
  } else {
    console.log("[razorpay-webhook] event ingested", {
      razorpayEventId: eventId,
      eventType,
      paymentEventId: result.paymentEventId,
    });
  }

  // Razorpay retries on any non-2xx response. A duplicate is not an error
  // from Razorpay's point of view - it's a successfully-received event we
  // already processed - so we return 200 either way.
  return NextResponse.json({ status: result.status }, { status: 200 });
}
