import { redirect } from "next/navigation";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { LoginForm } from "./LoginForm";

/**
 * Login (Phase 26 Phase C, screen 1). Renders outside AppShell entirely -
 * there is no sidebar/nav chrome on this route. Uses the existing
 * POST /api/auth/login contract only; no registration, MFA, or password
 * reset exist in the backend, so none are offered here.
 *
 * `demoError` (Phase 28C reliability fix) is set only when GET /demo
 * redirected back here after failing - this page never triggers that
 * flow itself, it only reads the query param to show an honest message.
 */
const DEMO_ERROR_MESSAGES: Record<string, string> = {
  rate_limited: "Too many attempts. Please wait a moment and try again.",
  unavailable: "The demo workspace is temporarily unavailable.",
  internal_error: "Could not open the demo. Try again.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ demoError?: string }>;
}) {
  const session = await authenticateOperator();
  if (session) {
    redirect("/overview");
  }

  const { demoError } = await searchParams;
  const demoErrorMessage = demoError ? (DEMO_ERROR_MESSAGES[demoError] ?? DEMO_ERROR_MESSAGES.internal_error) : null;

  return (
    <div className="bg-bg flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <div className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery</div>
          <h1 className="text-fg mt-4 text-xl font-semibold tracking-tight">Sign in</h1>
          <p className="text-fg-secondary mt-1 text-sm">Operator access for your merchant&apos;s recovery console.</p>
        </div>
        <LoginForm demoErrorMessage={demoErrorMessage} />
      </div>
    </div>
  );
}
