import { redirect } from "next/navigation";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { LoginForm } from "./LoginForm";

/**
 * Login (Phase 26 Phase C, screen 1). Renders outside AppShell entirely -
 * there is no sidebar/nav chrome on this route. Uses the existing
 * POST /api/auth/login contract only; no registration, MFA, or password
 * reset exist in the backend, so none are offered here.
 */
export default async function LoginPage() {
  const session = await authenticateOperator();
  if (session) {
    redirect("/overview");
  }

  return (
    <div className="bg-bg flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery</div>
          <h1 className="text-fg mt-4 text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-fg-secondary mt-1 text-sm">Operator access for your merchant&apos;s recovery console.</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
