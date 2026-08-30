import { prisma } from "@/lib/db";
import { hashPassword, isPasswordLongEnough } from "./password";
import { normalizeEmail, type OperatorIdentity } from "./authService";

/**
 * Public self-signup (Phase 26, Public Onboarding). Implements exactly the
 * one flow the prior architecture audit approved and this step's brief
 * confirmed: a visitor creates a brand-new Merchant/workspace and its
 * first Operator, atomically, with no existing-merchant selection input
 * anywhere in the contract.
 *
 * Deliberately a SEPARATE function from `authService.ts`'s existing
 * `createOperator(email, password, merchantId)` rather than a
 * modification of it: `createOperator` is out-of-band-provisioning-only,
 * already tested, and takes an ALREADY-EXISTING merchantId as a required
 * parameter - reusing it here would mean either creating the Merchant
 * first as a separate, non-atomic step (a real race window: a crash or
 * error between the two creates would leave an orphaned Merchant with no
 * Operator), or changing its signature/behavior for its existing
 * out-of-band callers. Reusing its two real primitives instead
 * (`hashPassword`, `isPasswordLongEnough`, and the exact same
 * `normalizeEmail`) keeps this genuinely new capability additive, not a
 * rewrite of already-audited code.
 *
 * Atomicity: `Merchant.create` and `Operator.create` run inside ONE
 * `prisma.$transaction` interactive callback (the same pattern already
 * used elsewhere in this codebase - see `candidateBuilder.ts`). If the
 * `Operator` insert fails for ANY reason (most importantly: the email's
 * UNIQUE constraint, P2002, under a genuine concurrent-duplicate-signup
 * race), Postgres rolls back the `Merchant` insert in the same
 * transaction too - there is no code path that can leave an orphaned
 * Merchant with zero Operators. Proven against a real database in
 * `signupService.integration.test.ts`, not merely asserted here.
 *
 * Merchant ownership is 100% server-derived: the caller never supplies a
 * merchantId, and `Merchant.create` generates its own id (`cuid()`,
 * `schema.prisma`) - there is structurally nothing in this function's own
 * input contract for a malicious caller to influence which Merchant an
 * Operator is created under, satisfying the audit's "never accept a
 * client-selected existing merchant ID" requirement by construction, not
 * by a runtime check that could be bypassed.
 */

export type SignUpResult =
  | { status: "created"; operator: OperatorIdentity; merchantId: string }
  | { status: "invalid_password" }
  | { status: "invalid_workspace_name" }
  | { status: "email_already_exists" };

const PRISMA_UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function prismaErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

const MAX_WORKSPACE_NAME_LENGTH = 200;

/** A non-empty, reasonably-bounded name - not a content policy, just
 * enough to reject an empty/whitespace-only value before it ever reaches
 * the database (`Merchant.name` is a required, non-nullable column). */
function isValidWorkspaceName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_WORKSPACE_NAME_LENGTH;
}

/**
 * Creates a new Merchant and its first Operator together, or returns a
 * typed failure. Validation happens BEFORE the transaction (and before
 * ever hashing the password) so an invalid request never touches the
 * database at all.
 *
 * The duplicate-email case (`email_already_exists`) is deliberately more
 * specific than login's uniform `invalid_credentials` - unlike login,
 * signup inherently has to tell a real visitor "this email is already
 * registered, sign in instead" for the flow to be usable at all, and no
 * email-verification step exists in this codebase to launder that
 * distinction away (the "always say 'check your email'" pattern some
 * products use to hide this requires exactly the email infrastructure
 * this step was told not to build). This is a documented, accepted
 * trade-off - see this module's final report §L - not an oversight: the
 * response still reveals nothing beyond "this email is taken" - never a
 * merchant id, workspace name, or any other detail about the existing
 * account.
 */
export async function signUpNewWorkspace(email: string, password: string, workspaceName: string): Promise<SignUpResult> {
  if (!isValidWorkspaceName(workspaceName)) {
    return { status: "invalid_workspace_name" };
  }
  if (!isPasswordLongEnough(password)) {
    return { status: "invalid_password" };
  }

  const passwordHash = await hashPassword(password);
  const normalizedEmail = normalizeEmail(email);
  const trimmedWorkspaceName = workspaceName.trim();

  try {
    const operator = await prisma.$transaction(async (tx) => {
      const merchant = await tx.merchant.create({
        data: { name: trimmedWorkspaceName },
      });
      return tx.operator.create({
        data: { merchantId: merchant.id, email: normalizedEmail, passwordHash },
      });
    });

    return { status: "created", operator: { id: operator.id, email: operator.email }, merchantId: operator.merchantId };
  } catch (error) {
    if (prismaErrorCode(error) === PRISMA_UNIQUE_CONSTRAINT_VIOLATION) {
      return { status: "email_already_exists" };
    }
    throw error;
  }
}
