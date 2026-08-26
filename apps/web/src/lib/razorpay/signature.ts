import { createHmac, timingSafeEqual } from "node:crypto";

export type SignatureVerificationResult =
  | { valid: true }
  | { valid: false; reason: SignatureRejectionReason };

export type SignatureRejectionReason =
  | "missing_webhook_secret"
  | "missing_signature_header"
  | "malformed_signature"
  | "signature_mismatch"
  | "signature_verification_error";

/**
 * Verifies a Razorpay webhook signature.
 *
 * Razorpay signs the *raw* request body with HMAC-SHA256 using the webhook
 * secret configured in the dashboard, hex-encodes the digest, and sends it
 * in the `X-Razorpay-Signature` header. We must:
 *   - operate on the raw (unparsed) body, since re-serializing JSON can
 *     change byte-for-byte content and break the signature check
 *   - compare digests with a constant-time comparison (`timingSafeEqual`)
 *     rather than `===`/string comparison, which leaks timing information
 *     an attacker could use to forge a valid signature byte-by-byte
 *   - fail closed (reject) if the webhook secret isn't configured, rather
 *     than silently accepting unsigned/unverifiable requests
 *   - never throw on attacker-controlled input (malformed or wrong-length
 *     signature headers) - always return a typed rejection instead
 */
export function verifyRazorpaySignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  webhookSecret: string | null | undefined
): SignatureVerificationResult {
  if (!webhookSecret) {
    return { valid: false, reason: "missing_webhook_secret" };
  }

  if (!signatureHeader) {
    return { valid: false, reason: "missing_signature_header" };
  }

  try {
    const expectedHex = createHmac("sha256", webhookSecret)
      .update(rawBody, "utf8")
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedHex, "hex");
    // `Buffer.from(str, "hex")` never throws for a non-hex or odd-length
    // string - it just stops decoding early, which yields a
    // shorter-than-expected buffer. That's exactly what we want: the
    // length check below turns malformed/wrong-length headers into a
    // clean rejection instead of a length-mismatch throw from
    // timingSafeEqual.
    const providedBuffer = Buffer.from(signatureHeader, "hex");

    if (
      providedBuffer.length === 0 ||
      providedBuffer.length !== expectedBuffer.length
    ) {
      return { valid: false, reason: "malformed_signature" };
    }

    const matches = timingSafeEqual(expectedBuffer, providedBuffer);
    if (!matches) {
      return { valid: false, reason: "signature_mismatch" };
    }

    return { valid: true };
  } catch {
    // Defensive: should be unreachable given the checks above, but we
    // never want signature verification to throw and take down request
    // handling on unexpected input.
    return { valid: false, reason: "signature_verification_error" };
  }
}
