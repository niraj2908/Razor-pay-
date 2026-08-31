import { prisma } from "@/lib/db";

/**
 * Demo/Evaluation Workspace configuration (Phase 28B).
 *
 * Every identifier here is a fixed, human-readable, obviously-synthetic
 * string - never a Prisma-generated cuid() - specifically so:
 *   1. Re-running the seed script is idempotent (find-by-known-id, not
 *      find-by-guessing), and
 *   2. Anyone reading these rows directly in the database immediately sees
 *      they are not a real signup (real Merchant/Operator/Experiment rows
 *      always get a default cuid(), which never collides with a
 *      human-readable string like "demo_merchant_revenue_recovery").
 *
 * This module contains NO seeding logic itself - only identity/config
 * resolution and the safety checks required before any write happens.
 */

export const DEMO_MERCHANT_ID = "demo_merchant_revenue_recovery";
export const DEMO_MERCHANT_NAME = "Demo — Revenue Recovery (Synthetic Test Mode)";
export const DEMO_OPERATOR_ID = "demo_operator_revenue_recovery";
// Deliberately alphanumeric-only, unlike the ids above: `/experiments/[id]`
// validates its route param with `isPlausibleId()`
// (recoveryQueueService.ts), which only accepts `[a-z0-9]` - an
// underscore-containing id (matching this module's other ids) 404s there.
// Confirmed by direct browser testing during Phase 28B; fixed here rather
// than loosening that shared, unmodified validation function.
export const DEMO_EXPERIMENT_ID = "demoexperimentpaymentlinknudge";

const DEFAULT_DEMO_OPERATOR_EMAIL = "demo-operator@revenue-recovery.demo";

/**
 * The complete identity of ONE demo-shaped workspace: which Merchant and
 * Operator rows it owns, which Experiment it runs, and the prefix every row
 * the seed creates is named with.
 *
 * This exists so the seed/reset pair is addressable rather than global. The
 * evaluator's Demo Workspace is `DEMO_IDENTITY` below; the integration suite
 * builds its own throwaway identity instead, which is what makes it
 * STRUCTURALLY impossible for a test's cleanup to delete the workspace an
 * evaluator is looking at.
 *
 * That mattered in practice: local development, the integration suite and
 * the deployed application all share one database, so a suite whose
 * `afterAll` reset the real demo left the deployment with no data at all.
 * Fixing that with an environment flag would only have moved the hazard;
 * giving the tests their own identity removes it.
 *
 * `idPrefix` must stay lowercase alphanumeric with underscores, and
 * `experimentId` must be alphanumeric ONLY - `/experiments/[id]` validates
 * its route param with `isPlausibleId()`, which rejects underscores.
 */
export type DemoWorkspaceIdentity = {
  merchantId: string;
  merchantName: string;
  operatorId: string;
  experimentId: string;
  idPrefix: string;
  /** Overrides the env-configured operator email. Used by tests so their
   * operator can never collide with the real demo operator's unique email. */
  operatorEmail?: string;
};

export const DEMO_IDENTITY: DemoWorkspaceIdentity = {
  merchantId: DEMO_MERCHANT_ID,
  merchantName: DEMO_MERCHANT_NAME,
  operatorId: DEMO_OPERATOR_ID,
  experimentId: DEMO_EXPERIMENT_ID,
  idPrefix: "demo",
};

/**
 * The demo operator's password MUST come from the environment - never
 * hardcoded, never committed (standing project requirement). There is
 * deliberately no fallback value: a missing `DEMO_OPERATOR_PASSWORD` fails
 * the seed closed rather than silently using a guessable default.
 */
const DEMO_OPERATOR_PASSWORD_ENV_VAR = "DEMO_OPERATOR_PASSWORD";
const DEMO_OPERATOR_EMAIL_ENV_VAR = "DEMO_OPERATOR_EMAIL";

export type DemoConfigResolution =
  | {
      status: "ready";
      merchantId: string;
      merchantName: string;
      operatorId: string;
      operatorEmail: string;
      operatorPassword: string;
      experimentId: string;
      idPrefix: string;
    }
  | { status: "missing_password"; reason: string }
  | { status: "unsafe_id_collision"; reason: string };

/**
 * Resolves and validates every piece of configuration the seed needs,
 * failing closed on anything unsafe BEFORE any database write is attempted.
 *
 * Two collision checks, both fail-closed:
 *   1. DEMO_MERCHANT_ID must never equal RAZORPAY_MERCHANT_ID (the one real,
 *      production-configured merchant - see merchantResolution.ts). If it
 *      ever did, a real webhook could theoretically be resolved onto the
 *      demo workspace - this must never be possible.
 *   2. If a Merchant row already exists at DEMO_MERCHANT_ID, it must
 *      already BE the demo merchant (same name) - never silently adopt or
 *      overwrite an unrelated row that happens to share this id (which
 *      would require someone to have deliberately crafted a colliding id,
 *      since real signups always get a random cuid()).
 */
export async function resolveDemoConfig(
  identity: DemoWorkspaceIdentity = DEMO_IDENTITY
): Promise<DemoConfigResolution> {
  const configuredRealMerchantId = process.env.RAZORPAY_MERCHANT_ID?.trim();
  if (configuredRealMerchantId && configuredRealMerchantId === identity.merchantId) {
    return {
      status: "unsafe_id_collision",
      reason: "The demo merchant id is identical to the configured RAZORPAY_MERCHANT_ID - refusing to seed.",
    };
  }

  const existing = await prisma.merchant.findUnique({ where: { id: identity.merchantId } });
  if (existing && existing.name !== identity.merchantName) {
    return {
      status: "unsafe_id_collision",
      reason: `A Merchant already exists at id "${identity.merchantId}" with name "${existing.name}", not the expected demo merchant name - refusing to touch an unrelated Merchant.`,
    };
  }

  const operatorPassword = process.env[DEMO_OPERATOR_PASSWORD_ENV_VAR];
  if (!operatorPassword || operatorPassword.trim().length === 0) {
    return {
      status: "missing_password",
      reason: `${DEMO_OPERATOR_PASSWORD_ENV_VAR} is not set - the demo operator's password must come from the environment, never a hardcoded default.`,
    };
  }

  const operatorEmail =
    identity.operatorEmail ?? (process.env[DEMO_OPERATOR_EMAIL_ENV_VAR]?.trim() || DEFAULT_DEMO_OPERATOR_EMAIL);

  return {
    status: "ready",
    merchantId: identity.merchantId,
    merchantName: identity.merchantName,
    operatorId: identity.operatorId,
    operatorEmail,
    operatorPassword,
    experimentId: identity.experimentId,
    idPrefix: identity.idPrefix,
  };
}
