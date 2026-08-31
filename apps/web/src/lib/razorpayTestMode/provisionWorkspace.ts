import { prisma } from "@/lib/db";
import { createOperator } from "@/lib/auth/authService";
import { DEMO_MERCHANT_ID } from "@/lib/demo/config";

/**
 * Provisions the dedicated Razorpay Test Mode workspace (Phase 29, final
 * build) - the one `Merchant` row that this deployment's single Razorpay
 * Test Mode account binds to via `RAZORPAY_MERCHANT_ID`.
 *
 * WHY A SEPARATE MERCHANT, not the Demo Workspace:
 *
 *   The Demo Workspace is deterministic synthetic data and its banner
 *   promises exactly that ("synthetic evaluation data, no real customer
 *   payments"). Pointing real Razorpay webhooks at it would make that
 *   statement false, would make the dataset non-reproducible, and - most
 *   dangerously - `resetDemoWorkspace()` (which the integration suite runs
 *   on every pass) would DELETE real Razorpay Test Mode payments as
 *   collateral. Keeping the two apart means synthetic demo data and real
 *   Test Mode ingestion can never contaminate or destroy one another.
 *
 * Idempotent by construction: fixed, human-readable ids (never a cuid()),
 * so re-running is a no-op rather than creating duplicates - the same
 * pattern `lib/demo/config.ts` established and for the same reason.
 *
 * This provisions IDENTITY ONLY. It creates no payments, risk events,
 * decisions or outcomes - those may only ever arrive through the real
 * webhook pipeline, because inventing them here is precisely the kind of
 * fabricated evidence this project forbids.
 */

export const RAZORPAY_TEST_MERCHANT_ID = "razorpay_test_mode_merchant";
export const RAZORPAY_TEST_MERCHANT_NAME = "Razorpay Test Mode";
export const RAZORPAY_TEST_OPERATOR_ID = "razorpay_test_mode_operator";

const DEFAULT_OPERATOR_EMAIL = "test-mode-operator@revenue-recovery.demo";
const OPERATOR_PASSWORD_ENV_VAR = "RAZORPAY_TEST_OPERATOR_PASSWORD";
const OPERATOR_EMAIL_ENV_VAR = "RAZORPAY_TEST_OPERATOR_EMAIL";

export type ProvisionResult =
  | { status: "provisioned" | "already_provisioned"; merchantId: string; operatorEmail: string }
  | { status: "unsafe"; reason: string };

/**
 * Creates (or confirms) the Razorpay Test Mode merchant and its operator.
 *
 * Fails closed rather than guessing:
 *   - no operator password in the environment -> refuses (never a default),
 *   - the fixed id already taken by a DIFFERENT merchant -> refuses rather
 *     than adopting or overwriting an unrelated row,
 *   - the id colliding with the Demo merchant -> refuses outright.
 */
export async function provisionRazorpayTestWorkspace(): Promise<ProvisionResult> {
  // No runtime "does this collide with the Demo merchant?" check is needed:
  // both ids are literal constants, so TypeScript proves they differ at
  // COMPILE time (a runtime comparison here is dead code, and tsc rejects
  // it as such). If either constant is ever edited to collide, the
  // assignment below stops type-checking - a stronger guarantee than a
  // check that could only fire after the damage was already possible.
  const _demoIdIsDistinct: Exclude<typeof RAZORPAY_TEST_MERCHANT_ID, typeof DEMO_MERCHANT_ID> = RAZORPAY_TEST_MERCHANT_ID;
  void _demoIdIsDistinct;

  const password = process.env[OPERATOR_PASSWORD_ENV_VAR];
  if (!password || password.trim().length === 0) {
    return {
      status: "unsafe",
      reason: `${OPERATOR_PASSWORD_ENV_VAR} is not set - the Test Mode operator password must come from the environment, never a hardcoded default.`,
    };
  }

  const email = process.env[OPERATOR_EMAIL_ENV_VAR]?.trim() || DEFAULT_OPERATOR_EMAIL;

  const existing = await prisma.merchant.findUnique({ where: { id: RAZORPAY_TEST_MERCHANT_ID } });
  if (existing && existing.name !== RAZORPAY_TEST_MERCHANT_NAME) {
    return {
      status: "unsafe",
      reason: `A different Merchant already occupies id "${RAZORPAY_TEST_MERCHANT_ID}" - refusing to touch an unrelated Merchant.`,
    };
  }

  if (existing) {
    const operator = await prisma.operator.findUnique({ where: { id: RAZORPAY_TEST_OPERATOR_ID } });
    if (operator) {
      return { status: "already_provisioned", merchantId: existing.id, operatorEmail: operator.email };
    }
  }

  const merchant =
    existing ??
    (await prisma.merchant.create({
      data: { id: RAZORPAY_TEST_MERCHANT_ID, name: RAZORPAY_TEST_MERCHANT_NAME },
    }));

  // Reuse the real provisioning path so the password is hashed by exactly
  // the same scrypt code every other operator goes through.
  const created = await createOperator(email, password, merchant.id);
  if (created.status !== "created") {
    return { status: "unsafe", reason: `Operator provisioning failed: ${created.status}` };
  }

  // createOperator generates a cuid(); pin it to the fixed id so this whole
  // routine stays idempotent on a re-run.
  await prisma.operator.update({
    where: { id: created.operator.id },
    data: { id: RAZORPAY_TEST_OPERATOR_ID },
  });

  return { status: "provisioned", merchantId: merchant.id, operatorEmail: email };
}
