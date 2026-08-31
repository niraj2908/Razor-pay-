import { redirect } from "next/navigation";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { LoginForm } from "./LoginForm";
import { FailureIcon, EngineIcon, AuditIcon, ExperimentIcon } from "@/lib/design/icons";

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
    <div className="bg-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="grid w-full max-w-4xl items-center gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <section>
          <div className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery Intelligence</div>
          <h1 className="text-fg mt-3 text-3xl leading-tight font-semibold tracking-tight text-balance">
            Recover the revenue that failed payments leave behind.
          </h1>
          <p className="text-fg-secondary mt-3 text-base">
            A failed payment is not a lost customer yet. This console diagnoses why each payment failed, decides whether
            acting is worth it, carries the decision out through Razorpay, and then measures what the intervention
            actually recovered.
          </p>

          <dl className="mt-8 flex flex-col gap-5">
            {CAPABILITIES.map(({ icon: Icon, term, detail }) => (
              <div key={term} className="flex gap-3">
                <span aria-hidden="true" className="bg-surface-subtle text-fg-secondary mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">
                  <Icon aria-hidden="true" className="h-4 w-4" />
                </span>
                <div>
                  <dt className="text-fg text-sm font-medium">{term}</dt>
                  <dd className="text-fg-secondary mt-0.5 text-sm">{detail}</dd>
                </div>
              </div>
            ))}
          </dl>
        </section>

        <section className="border-border bg-surface rounded-lg border p-6 shadow-sm">
          <h2 className="text-fg text-lg font-semibold tracking-tight">Sign in</h2>
          <p className="text-fg-secondary mt-1 text-sm">Operator access for your merchant&apos;s recovery console.</p>
          <div className="mt-6">
            <LoginForm demoErrorMessage={demoErrorMessage} />
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Every claim here is something the running application demonstrably does,
 * checkable in the Demo Workspace within a minute of arriving - the landing
 * copy must never describe capability the product does not have.
 */
const CAPABILITIES = [
  {
    icon: FailureIcon,
    term: "Diagnoses the failure, not just the error code",
    detail:
      "Network degradation, customer abandonment, an uncertain payment state and more - each with its own recovery probability.",
  },
  {
    icon: EngineIcon,
    term: "Decides Act, Wait, Stop or Escalate",
    detail:
      "A deterministic engine weighs expected value against safety and policy gates, so a case can be stopped or escalated rather than blindly retried.",
  },
  {
    icon: AuditIcon,
    term: "Shows its reasoning for every decision",
    detail: "Each one records the policy version, model version and the reason code that produced it, end to end.",
  },
  {
    icon: ExperimentIcon,
    term: "Proves what actually worked",
    detail:
      "Recovery is measured against a randomised control arm, and a causal figure is reported only once that experiment passes its validity checks.",
  },
] as const;
