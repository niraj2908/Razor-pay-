import { redirect } from "next/navigation";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { SignupForm } from "./SignupForm";

/**
 * Public signup (Phase 26, Public Onboarding). Renders outside AppShell,
 * matching /login's own pattern exactly - no sidebar/nav chrome on this
 * route. Uses the existing POST /api/auth/signup contract only.
 *
 * Creating an account here always creates a brand-new, private
 * Merchant/workspace and its first Operator - there is no way to join an
 * existing workspace from this page, by design (see the approved
 * onboarding architecture: a public visitor must never be able to select
 * or guess an existing merchant).
 */
export default async function SignupPage() {
  const session = await authenticateOperator();
  if (session) {
    redirect("/overview");
  }

  return (
    <div className="bg-bg flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery</div>
          <h1 className="text-fg mt-4 text-xl font-semibold tracking-tight">Create your workspace</h1>
          <p className="text-fg-secondary mt-1 text-sm">
            This creates a new, private workspace for your business. Nobody else can see your data.
          </p>
        </div>
        <SignupForm />
      </div>
    </div>
  );
}
