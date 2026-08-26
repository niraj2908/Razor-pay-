import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyRazorpaySignature } from "./signature";

const SECRET = "test_webhook_secret_123";
const BODY = JSON.stringify({
  event: "payment.captured",
  payload: { payment: { entity: { id: "pay_ABC123", amount: 50000 } } },
});

function signFor(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

describe("verifyRazorpaySignature", () => {
  it("accepts a valid signature", () => {
    const signature = signFor(BODY, SECRET);
    const result = verifyRazorpaySignature(BODY, signature, SECRET);
    expect(result).toEqual({ valid: true });
  });

  it("rejects when the body has been tampered with after signing", () => {
    const signature = signFor(BODY, SECRET);
    const tamperedBody = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_ABC123", amount: 999999999 } } },
    });
    const result = verifyRazorpaySignature(tamperedBody, signature, SECRET);
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("rejects when the signature was produced with the wrong secret", () => {
    const signature = signFor(BODY, "a_completely_different_secret");
    const result = verifyRazorpaySignature(BODY, signature, SECRET);
    expect(result).toEqual({ valid: false, reason: "signature_mismatch" });
  });

  it("fails closed when the webhook secret env var is missing", () => {
    const signature = signFor(BODY, SECRET);
    const result = verifyRazorpaySignature(BODY, signature, undefined);
    expect(result).toEqual({ valid: false, reason: "missing_webhook_secret" });
  });

  it("also fails closed when the webhook secret is an empty string", () => {
    const signature = signFor(BODY, SECRET);
    const result = verifyRazorpaySignature(BODY, signature, "");
    expect(result).toEqual({ valid: false, reason: "missing_webhook_secret" });
  });

  it("rejects when the signature header is missing", () => {
    const result = verifyRazorpaySignature(BODY, null, SECRET);
    expect(result).toEqual({ valid: false, reason: "missing_signature_header" });
  });

  it("rejects a malformed (non-hex) signature header without throwing", () => {
    expect(() =>
      verifyRazorpaySignature(BODY, "not-a-valid-hex-signature!!", SECRET)
    ).not.toThrow();

    const result = verifyRazorpaySignature(
      BODY,
      "not-a-valid-hex-signature!!",
      SECRET
    );
    expect(result).toEqual({ valid: false, reason: "malformed_signature" });
  });

  it("rejects a wrong-length signature header without throwing", () => {
    expect(() => verifyRazorpaySignature(BODY, "abcd", SECRET)).not.toThrow();

    const result = verifyRazorpaySignature(BODY, "abcd", SECRET);
    expect(result).toEqual({ valid: false, reason: "malformed_signature" });
  });

  it("rejects an empty-string signature header without throwing", () => {
    expect(() => verifyRazorpaySignature(BODY, "", SECRET)).not.toThrow();
    const result = verifyRazorpaySignature(BODY, "", SECRET);
    expect(result.valid).toBe(false);
  });
});
