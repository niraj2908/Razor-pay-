import { prisma } from "@/lib/db";

/**
 * Configured-Merchant resolution for the single-Razorpay-account deployment
 * model (Phase 25, payment-ingestion merchant-resolution audit, approved
 * architecture decision).
 *
 * This deployment has exactly ONE configured Razorpay account (one
 * RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET triple - see
 * apps/web/src/lib/razorpay/client.ts and apps/web/src/lib/razorpay/signature.ts,
 * both unchanged by this file). A request that passes
 * `verifyRazorpaySignature` has proven only "this came from the one account
 * we're configured for" - it says nothing about WHICH `Merchant` row that
 * account corresponds to. This module answers exactly that second question,
 * and ONLY that question.
 *
 * The audit that preceded this file found NO field in any Razorpay webhook
 * payload that safely and deterministically identifies a Merchant for a
 * brand-new, customer-initiated payment (razorpayPaymentId/order_id/
 * payment_link_id/customer id/email/phone/amount/currency/notes were all
 * evaluated and rejected - see that audit's Section 2). The only trusted
 * source left is therefore SERVER-SIDE CONFIGURATION, never webhook content -
 * which is exactly why `resolveConfiguredMerchant` takes NO arguments at
 * all: there is structurally nothing for an attacker-controlled payload
 * field to influence.
 *
 * `RAZORPAY_MERCHANT_ID` (new env var, documented in .env.example) names
 * the one Merchant this deployment's single Razorpay account belongs to.
 * This is intentionally NOT inferred from any existing schema field
 * (`Merchant.razorpayAccountId` exists but is unpopulated by any code path -
 * see the audit) - inferring from an unpopulated column would be exactly
 * the kind of silent, undetectable misconfiguration this module must fail
 * closed against instead. A plain, explicit, required env var makes a
 * missing or wrong binding immediately visible (this module returns a
 * non-"resolved" status) rather than silently falling back to anything.
 *
 * Fails closed, never guesses, never falls back to "the only Merchant row"
 * or "the first Merchant row" - both of those would be inferring identity
 * from mutable database state rather than from trusted configuration, and
 * neither is used anywhere in this file.
 */

export type ResolveConfiguredMerchantResult =
  | { status: "resolved"; merchantId: string }
  /** RAZORPAY_MERCHANT_ID is unset or blank. */
  | { status: "not_configured" }
  /** RAZORPAY_MERCHANT_ID is set but does not match any real Merchant row -
   * treated identically to "not configured" by every caller (fail closed),
   * kept as a distinct status only so this can be logged/alerted on
   * differently from a simply-unset variable. */
  | { status: "unresolvable" };

const RAZORPAY_MERCHANT_ID_ENV_VAR = "RAZORPAY_MERCHANT_ID";

/**
 * Resolves the single Merchant this deployment's one configured Razorpay
 * account belongs to. Takes no parameters - this is deliberate (see this
 * module's doc comment): there is nothing for a caller to pass in that
 * could influence which Merchant is returned, so no webhook payload field,
 * however attacker-controlled, can ever reach this function's decision.
 *
 * Callers MUST treat every non-"resolved" result as "do not proceed" -
 * never as permission to pick a different Merchant on their own.
 */
export async function resolveConfiguredMerchant(): Promise<ResolveConfiguredMerchantResult> {
  const configuredMerchantId = process.env[RAZORPAY_MERCHANT_ID_ENV_VAR];
  if (!configuredMerchantId || configuredMerchantId.trim().length === 0) {
    return { status: "not_configured" };
  }

  const merchant = await prisma.merchant.findUnique({
    where: { id: configuredMerchantId },
    select: { id: true },
  });

  if (!merchant) {
    return { status: "unresolvable" };
  }

  return { status: "resolved", merchantId: merchant.id };
}
