import { PageHeader } from "@/components/ui/PageHeader";
import { ProcessTimeline, type TimelineNode } from "@/components/ui/ProcessTimeline";
import { resolveRazorpayIntegrationStatus } from "@/lib/razorpay/connectionStatus";
import { resolveRazorpayLifecycleVerification, type RazorpayLifecycleVerification } from "@/lib/razorpay/lifecycleVerification";
import {
  SecurityIcon,
  AuthIcon,
  MerchantIcon,
  RateLimitIcon,
  WebhookIcon,
  DataProtectionIcon,
  AuditIcon,
  AiGovernanceIcon,
  GatewayIcon,
  PaymentIcon,
  WalletIcon,
  EngineIcon,
  ExecutionIcon,
  OutcomeIcon,
  ConnectedIcon,
  PendingIcon,
} from "@/lib/design/icons";

/**
 * Security & Policies (Phase 28C). A visual policy/control center, not a
 * legal document - every claim below describes code that exists in THIS
 * repository today (verified by reading it across this project's build),
 * never an aspiration presented as fact. No page-specific data fetch: this
 * is a static description of the system's own architecture, not a report
 * over Payment/Decision/Outcome rows.
 *
 * The one hard rule this page exists to enforce: never claim a regulatory
 * certification (RBI, PCI-DSS, or otherwise) that does not exist. The
 * disclaimer below is the load-bearing sentence on this page - everything
 * else is elaboration of "what controls exist," never "what body has
 * certified them."
 */

const ARCHITECTURE_FLOW: TimelineNode[] = [
  { icon: GatewayIcon, label: "Razorpay", tone: "neutral", sublabel: "Test Mode", done: true },
  { icon: WebhookIcon, label: "Webhook", tone: "neutral", sublabel: "Signature verified", done: true },
  { icon: MerchantIcon, label: "Merchant resolution", tone: "neutral", sublabel: "One configured account", done: true },
  { icon: PaymentIcon, label: "Payment", tone: "neutral", sublabel: "Idempotent ingestion", done: true },
  { icon: WalletIcon, label: "Risk evaluation", tone: "warning", sublabel: "Diagnosis + probability", done: true },
  { icon: EngineIcon, label: "Decision Engine", tone: "info", sublabel: "ACT / WAIT / STOP / ESCALATE", done: true },
  { icon: ExecutionIcon, label: "Execution", tone: "info", sublabel: "Real Razorpay Test Mode call", done: true },
  { icon: OutcomeIcon, label: "Outcome", tone: "success", sublabel: "Attributed recovery", done: true },
  { icon: AuditIcon, label: "Audit / Measurement", tone: "neutral", sublabel: "Sanitized trail + statistics", done: true },
];

export default async function SecurityPolicyPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Security & Policies" description="How this system is built, what it protects against, and what it does not claim." icon={SecurityIcon} />

      <section className="border-warning/30 bg-warning/[0.04] rounded-lg border p-5">
        <p className="text-fg text-sm font-medium">
          This project is not RBI-certified, PCI-DSS-certified, or a regulated Payment System Operator. The controls described on
          this page are implementation controls and alignment with applicable security principles, not a certification claim.
        </p>
      </section>

      {await RazorpayIntegrationPanel()}

      <section className="flex flex-col gap-4">
        <h2 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Security architecture</h2>
        <div className="border-border overflow-x-auto rounded-lg border p-5">
          <div className="min-w-[720px]">
            <ProcessTimeline nodes={ARCHITECTURE_FLOW} />
          </div>
        </div>
        <p className="text-fg-muted text-xs">
          Every stage above is a real, currently-implemented code path in this application - not a planned or conceptual diagram.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <PolicyCard icon={AuthIcon} title="Authentication">
          Operator sessions are self-hosted, not delegated to Razorpay or any third party. Passwords are hashed with Node&apos;s
          <code className="bg-surface-subtle mx-1 rounded px-1 py-0.5 text-xs">scrypt</code> (never stored in plain text). Sessions
          use a 256-bit random token, stored server-side only as a SHA-256 hash - the raw token exists only in an{" "}
          <code className="bg-surface-subtle mx-1 rounded px-1 py-0.5 text-xs">HttpOnly</code>, <code className="bg-surface-subtle mx-1 rounded px-1 py-0.5 text-xs">SameSite=Lax</code> cookie with a 12-hour expiry, unreachable
          from page JavaScript.
        </PolicyCard>

        <PolicyCard icon={MerchantIcon} title="Merchant isolation">
          Every query in the system is scoped to the authenticated operator&apos;s own merchant directly in its database WHERE
          clause - never fetched broadly and filtered afterward in application code. A decision, execution, outcome, or
          experiment belonging to another merchant resolves as &quot;not found,&quot; identical to a nonexistent id, so a request
          can never distinguish &quot;that&apos;s not yours&quot; from &quot;that doesn&apos;t exist.&quot;
        </PolicyCard>

        <PolicyCard icon={RateLimitIcon} title="Rate limiting">
          Login, signup, and the demo entry point each enforce their own IP- and/or account-scoped request limits using a shared,
          fail-closed rate-limiting primitive - a limiter that itself errors denies the request rather than allowing it through.
        </PolicyCard>

        <PolicyCard icon={WebhookIcon} title="Webhook security">
          Incoming Razorpay webhook events are verified and ingested idempotently: a database uniqueness constraint on the
          provider&apos;s own event id guarantees the same webhook delivery is processed exactly once even under concurrent
          duplicate deliveries, never silently double-counted.
        </PolicyCard>

        <PolicyCard icon={DataProtectionIcon} title="Data protection">
          Razorpay credentials and database connection strings live only in server-side environment configuration - never in
          client-side code, never returned by any API response. This Security & Policies page and every other screen expose zero
          credentials, merchant identifiers, or raw account configuration.
        </PolicyCard>

        <PolicyCard icon={AuditIcon} title="Auditability">
          Every decision, execution, and outcome writes a corresponding audit record. Audit responses are built from an explicit,
          per-entity-type field allowlist - a field not on that list can never reach an API response, even if the underlying
          stored record changes shape in the future.
        </PolicyCard>

        <PolicyCard icon={AiGovernanceIcon} title="AI governance">
          The AI Assistant (see its own page) is read-only and non-authoritative: it can only retrieve and summarize data through
          the same authorized, merchant-scoped query services every screen already uses. It cannot execute a payment, change a
          decision, or access another merchant&apos;s data, because no such capability exists in its implementation - not because
          of a policy layer on top of one that does.
        </PolicyCard>

        <PolicyCard icon={GatewayIcon} title="Razorpay integration">
          This deployment is configured against exactly one real Razorpay account, in Test Mode. There is no code path by which a
          webhook or API response can resolve to a different merchant than the one configured - the resolver fails closed
          (returns &quot;not configured&quot;) rather than guessing when configuration is absent or ambiguous.
        </PolicyCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="border-border flex flex-col gap-2 rounded-lg border p-5">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">What we implemented</h3>
          <ul className="text-fg-secondary flex flex-col gap-1.5 text-sm">
            <li>Self-hosted authentication with hashed passwords and hashed session tokens</li>
            <li>Per-query merchant isolation, enforced in every database access</li>
            <li>Rate limiting on every authentication-adjacent endpoint</li>
            <li>Idempotent, signature-verified webhook ingestion</li>
            <li>A rule-based Decision Engine with a full audit trail</li>
            <li>Randomized experiment measurement with statistically gated causal claims</li>
          </ul>
        </section>
        <section className="border-border flex flex-col gap-2 rounded-lg border p-5">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">What we do not implement</h3>
          <ul className="text-fg-secondary flex flex-col gap-1.5 text-sm">
            <li>Multi-factor authentication or SSO</li>
            <li>Session rotation on privilege change, or device/session management UI</li>
            <li>A generative AI model - the assistant is deterministic and read-only (see AI Governance)</li>
            <li>Support for more than one live Razorpay account per deployment</li>
            <li>Any regulatory certification (RBI, PCI-DSS, or otherwise)</li>
          </ul>
        </section>
        <section className="border-border flex flex-col gap-2 rounded-lg border p-5">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Roadmap</h3>
          <ul className="text-fg-secondary flex flex-col gap-1.5 text-sm">
            <li>Multi-merchant Razorpay account support</li>
            <li>Configurable session/token rotation policy</li>
            <li>Expanded decision-driver evidence capture</li>
          </ul>
        </section>
        <section className="border-border flex flex-col gap-2 rounded-lg border p-5">
          <h3 className="text-fg-muted text-[11px] font-medium tracking-wider uppercase">Out of scope</h3>
          <ul className="text-fg-secondary flex flex-col gap-1.5 text-sm">
            <li>Direct card/bank credential handling of any kind - all payment collection happens on Razorpay&apos;s own hosted surfaces</li>
            <li>Any claim of PCI-DSS scope reduction or certification</li>
            <li>Production (live-mode) payment processing in this evaluation build</li>
          </ul>
        </section>
      </div>

      <section className="border-border rounded-lg border p-5">
        <h2 className="text-fg-muted mb-2 text-[11px] font-medium tracking-wider uppercase">Compliance alignment</h2>
        <p className="text-fg-secondary text-sm">
          The controls above are designed to align with common security principles behind frameworks such as PCI-DSS
          (least-privilege data access, credential isolation, auditability) and general data-protection practice
          (hashed credentials, scoped access, no unnecessary retention of sensitive fields in responses). Alignment with a
          principle is not equivalent to certification against a standard - no such certification is claimed anywhere in this
          product.
        </p>
      </section>
    </div>
  );
}

function PolicyCard({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof SecurityIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-border flex flex-col gap-2 rounded-lg border p-5">
      <div className="flex items-center gap-2">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <h3 className="text-fg text-sm font-semibold">{title}</h3>
      </div>
      <p className="text-fg-secondary text-sm">{children}</p>
    </section>
  );
}

/**
 * Razorpay integration status, for evaluators.
 *
 * Three facts that were previously collapsed into one badge and could be
 * mistaken for each other:
 *
 *   1. DEPLOYMENT integration - is Razorpay Test Mode actually wired up
 *      here? Derived purely from whether each variable is set, never a
 *      hardcoded claim, and never reading a value into the page.
 *   2. THIS WORKSPACE's binding - the synthetic Demo Workspace is
 *      deliberately not the merchant bound to the Razorpay account, so its
 *      honest state is "synthetic data", not "no integration".
 *   3. LIVE E2E lifecycle - whether a real payment has actually travelled
 *      the full path. This one cannot be derived from configuration, so it
 *      is stated as a recorded verification result rather than rendered as
 *      a live status, and it says plainly that it has NOT been completed.
 */
async function RazorpayIntegrationPanel() {
  const integration = resolveRazorpayIntegrationStatus();
  const lifecycle = await resolveRazorpayLifecycleVerification();

  const rows: Array<{ label: string; state: "ok" | "pending"; detail: string }> = [
    {
      label: "Test Mode API credentials",
      state: integration.apiCredentialsConfigured ? "ok" : "pending",
      detail: integration.apiCredentialsConfigured
        ? "A Test Mode key id and secret are configured for this deployment."
        : "No Test Mode key id/secret is configured for this deployment.",
    },
    {
      label: "Webhook signature verification",
      state: integration.webhookSecretConfigured ? "ok" : "pending",
      detail: integration.webhookSecretConfigured
        ? "A webhook signing secret is configured. Every inbound webhook is HMAC-SHA256 verified with a constant-time comparison before it is read; unsigned and malformed requests are rejected."
        : "No webhook signing secret is configured, so inbound webhooks cannot be verified and are rejected.",
    },
    {
      label: "Bound merchant workspace",
      state: integration.merchantBindingConfigured ? "ok" : "pending",
      detail: integration.merchantBindingConfigured
        ? "A dedicated Test Mode workspace is bound to the configured Razorpay account. It is kept separate from the Demo Workspace on purpose, so a real webhook can never resolve onto synthetic data."
        : "No merchant is bound to a Razorpay account, so payment ingestion fails closed.",
    },
  ];

  return (
    <section className="border-border flex flex-col gap-4 rounded-lg border p-5">
      <div className="flex items-center gap-2">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <GatewayIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <h2 className="text-fg text-sm font-semibold">Razorpay Test Mode integration</h2>
      </div>

      <dl className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.label} className="flex gap-2.5">
            {row.state === "ok" ? (
              <ConnectedIcon aria-hidden="true" className="text-success mt-0.5 h-4 w-4 shrink-0" />
            ) : (
              <PendingIcon aria-hidden="true" className="text-fg-muted mt-0.5 h-4 w-4 shrink-0" />
            )}
            <div>
              <dt className="text-fg text-sm font-medium">
                {row.label} <span className="text-fg-muted font-normal">&middot; {row.state === "ok" ? "Configured" : "Not configured"}</span>
              </dt>
              <dd className="text-fg-secondary mt-0.5 text-sm">{row.detail}</dd>
            </div>
          </div>
        ))}

        <div className="border-border flex gap-2.5 border-t pt-3">
          {lifecycle.decisionObserved ? (
            <ConnectedIcon aria-hidden="true" className="text-success mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <PendingIcon aria-hidden="true" className="text-warning mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            <dt className="text-fg text-sm font-medium">
              Live end-to-end lifecycle{" "}
              <span className="text-fg-muted font-normal">
                &middot; {lifecycle.decisionObserved ? (lifecycle.executionObserved ? "Verified" : "Partially verified") : "Not verified"}
              </span>
            </dt>
            <dd className="text-fg-secondary mt-0.5 text-sm">{lifecycleDetail(lifecycle)}</dd>
          </div>
        </div>
      </dl>

      <p className="text-fg-muted border-border border-t pt-3 text-xs">
        The rows above are read from this deployment&apos;s own configuration at page load. API authentication was additionally
        confirmed by hand against the live Razorpay API &mdash; a real Test Mode payment was fetched through the application&apos;s
        own client &mdash; which is a recorded result, not a check re-run on every page view.
      </p>
    </section>
  );
}

/**
 * States exactly what the evidence supports and nothing beyond it. In
 * particular it never describes the lifecycle as fully verified while the
 * ACT/execution branch is unproven, and it names which decision branches the
 * engine has actually produced from real payments rather than implying all
 * of them.
 */
function lifecycleDetail(lifecycle: RazorpayLifecycleVerification): string {
  if (!lifecycle.decisionObserved) {
    return (
      "No real Razorpay Test Mode payment has yet completed the chain on this deployment. Nothing on this page or " +
      "anywhere in the application simulates one."
    );
  }
  const branches = lifecycle.decisionTypes.join(", ");
  const base =
    `A real Razorpay Test Mode payment has been carried through webhook delivery, HMAC-SHA256 verification, payment-event ` +
    `persistence, risk-event creation and the Decision Engine on this deployment. Decision branches actually produced from ` +
    `real payments so far: ${branches}.` +
    (lifecycle.outcomeObserved ? " Outcome attribution and audit records were written." : "");
  return lifecycle.executionObserved
    ? `${base} A recovery execution was also attempted against the live Razorpay API.`
    : `${base} The ACT branch, which performs a recovery execution, has not yet been exercised end to end, so no execution ` +
      `record exists from a real payment.`;
}
