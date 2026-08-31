/**
 * Read-only Razorpay connection-state check for the UI (Phase 28C).
 *
 * Does not modify or call `merchantResolution.ts`/`razorpay/client.ts` -
 * this is a separate, additive, read-only helper so the UI can honestly
 * state whether THIS merchant's workspace is the one real, configured
 * Razorpay account, without ever exposing the actual `RAZORPAY_MERCHANT_ID`
 * value, key id/secret, or any other credential to the browser.
 *
 * This deployment has exactly one configured Razorpay account (see
 * `merchantResolution.ts`'s own doc comment) - a merchant can therefore
 * only ever be "connected" if its id happens to equal that one configured
 * value. Every other merchant (including every self-signed-up workspace
 * and the Demo Workspace) is honestly "not configured" - never displayed
 * as "Connected" merely because credentials exist somewhere in the
 * environment.
 */
export type RazorpayConnectionState =
  | { status: "connected" }
  | { status: "not_configured" };

export function resolveRazorpayConnectionState(merchantId: string): RazorpayConnectionState {
  const configuredMerchantId = process.env.RAZORPAY_MERCHANT_ID?.trim();
  const hasCredentials = Boolean(process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim());

  if (configuredMerchantId && hasCredentials && configuredMerchantId === merchantId) {
    return { status: "connected" };
  }
  return { status: "not_configured" };
}
