import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRazorpayConnectionState, resolveRazorpayIntegrationStatus } from "./connectionStatus";

/**
 * These states drive what an evaluator is told about the Razorpay
 * integration, so the thing worth proving is that every one of them is
 * DERIVED from configuration rather than asserted. A hardcoded "configured"
 * would be exactly the kind of unearned claim this project refuses to make,
 * and it would still render green with nothing wired up at all.
 */
const VARS = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_MERCHANT_ID"] as const;

let saved: Partial<Record<(typeof VARS)[number], string | undefined>> = {};

beforeEach(() => {
  saved = {};
  for (const v of VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("resolveRazorpayConnectionState", () => {
  it("reports not_configured when nothing is configured", () => {
    expect(resolveRazorpayConnectionState("any_merchant")).toEqual({ status: "not_configured" });
  });

  it("reports not_configured when a merchant is bound but credentials are absent", () => {
    process.env.RAZORPAY_MERCHANT_ID = "merchant_a";
    expect(resolveRazorpayConnectionState("merchant_a")).toEqual({ status: "not_configured" });
  });

  it("reports connected only for the merchant actually bound to the configured account", () => {
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.RAZORPAY_MERCHANT_ID = "merchant_a";
    expect(resolveRazorpayConnectionState("merchant_a")).toEqual({ status: "connected" });
  });

  it("reports configured_other_workspace for a different merchant, never connected", () => {
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    process.env.RAZORPAY_MERCHANT_ID = "merchant_a";
    // The Demo Workspace is this case: the integration is configured for the
    // deployment, but this workspace is deliberately not the bound one.
    expect(resolveRazorpayConnectionState("demo_merchant")).toEqual({ status: "configured_other_workspace" });
  });

  it("never reports a connected or configured state on the strength of credentials alone", () => {
    process.env.RAZORPAY_KEY_ID = "key";
    process.env.RAZORPAY_KEY_SECRET = "secret";
    expect(resolveRazorpayConnectionState("merchant_a")).toEqual({ status: "not_configured" });
  });
});

describe("resolveRazorpayIntegrationStatus", () => {
  it("reports every deployment-level fact as false when nothing is set", () => {
    expect(resolveRazorpayIntegrationStatus()).toEqual({
      apiCredentialsConfigured: false,
      webhookSecretConfigured: false,
      merchantBindingConfigured: false,
    });
  });

  it("requires BOTH key id and secret before calling API credentials configured", () => {
    process.env.RAZORPAY_KEY_ID = "key";
    expect(resolveRazorpayIntegrationStatus().apiCredentialsConfigured).toBe(false);
    process.env.RAZORPAY_KEY_SECRET = "secret";
    expect(resolveRazorpayIntegrationStatus().apiCredentialsConfigured).toBe(true);
  });

  it("tracks the webhook secret and merchant binding independently of the API credentials", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec";
    expect(resolveRazorpayIntegrationStatus()).toEqual({
      apiCredentialsConfigured: false,
      webhookSecretConfigured: true,
      merchantBindingConfigured: false,
    });

    process.env.RAZORPAY_MERCHANT_ID = "merchant_a";
    expect(resolveRazorpayIntegrationStatus().merchantBindingConfigured).toBe(true);
  });

  it("treats a whitespace-only value as absent rather than configured", () => {
    process.env.RAZORPAY_KEY_ID = "   ";
    process.env.RAZORPAY_KEY_SECRET = "   ";
    process.env.RAZORPAY_WEBHOOK_SECRET = "   ";
    process.env.RAZORPAY_MERCHANT_ID = "   ";
    expect(resolveRazorpayIntegrationStatus()).toEqual({
      apiCredentialsConfigured: false,
      webhookSecretConfigured: false,
      merchantBindingConfigured: false,
    });
  });
});
