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
 * and the Demo Workspace) is honestly not connected - never displayed
 * as "Connected" merely because credentials exist somewhere in the
 * environment.
 *
 * WHY THREE STATES RATHER THAN TWO: the Demo Workspace is deliberately not
 * bound to the Razorpay account (binding it would let a real webhook resolve
 * onto synthetic data, and `resetDemoWorkspace()` would delete real Test
 * Mode payments). Collapsing that into a bare "Not configured" was
 * technically true of the workspace but read as "this project has no
 * Razorpay integration", which is false: the integration is implemented and
 * configured at the deployment level. The states below separate
 * DEPLOYMENT-level configuration from THIS WORKSPACE's binding, so neither
 * fact can be mistaken for the other.
 */
export type RazorpayConnectionState =
  /** This workspace IS the merchant bound to the configured Razorpay account. */
  | { status: "connected" }
  /** Razorpay Test Mode is configured for this deployment, but this
   *  workspace is deliberately not the bound one (e.g. the synthetic Demo). */
  | { status: "configured_other_workspace" }
  /** No Razorpay credentials/merchant are configured for this deployment. */
  | { status: "not_configured" };

/**
 * Deployment-level integration facts, each derived from whether a variable
 * is actually set - never a hardcoded claim that the integration exists.
 * Values themselves are never read into the return type, only their
 * presence, so nothing credential-bearing can reach the browser.
 */
export type RazorpayIntegrationStatus = {
  /** Test Mode API key id + secret are both present. */
  apiCredentialsConfigured: boolean;
  /** A webhook signing secret is present, so HMAC verification can succeed. */
  webhookSecretConfigured: boolean;
  /** A Merchant row is bound to the configured Razorpay account. */
  merchantBindingConfigured: boolean;
};

function readConfig() {
  const configuredMerchantId = process.env.RAZORPAY_MERCHANT_ID?.trim();
  const apiCredentialsConfigured = Boolean(
    process.env.RAZORPAY_KEY_ID?.trim() && process.env.RAZORPAY_KEY_SECRET?.trim()
  );
  const webhookSecretConfigured = Boolean(process.env.RAZORPAY_WEBHOOK_SECRET?.trim());
  return { configuredMerchantId, apiCredentialsConfigured, webhookSecretConfigured };
}

export function resolveRazorpayIntegrationStatus(): RazorpayIntegrationStatus {
  const { configuredMerchantId, apiCredentialsConfigured, webhookSecretConfigured } = readConfig();
  return {
    apiCredentialsConfigured,
    webhookSecretConfigured,
    merchantBindingConfigured: Boolean(configuredMerchantId),
  };
}

export function resolveRazorpayConnectionState(merchantId: string): RazorpayConnectionState {
  const { configuredMerchantId, apiCredentialsConfigured } = readConfig();

  if (!configuredMerchantId || !apiCredentialsConfigured) {
    return { status: "not_configured" };
  }
  if (configuredMerchantId === merchantId) {
    return { status: "connected" };
  }
  return { status: "configured_other_workspace" };
}
