import type { ReactNode } from "react";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { DEMO_MERCHANT_ID } from "@/lib/demo/config";
import { resolveRazorpayConnectionState, type RazorpayConnectionState } from "@/lib/razorpay/connectionStatus";
import { AppShell } from "@/components/shell/AppShell";

/**
 * Layout for every authenticated route (Phase 26 Phase C). Each page under
 * this group still calls `requireAuthContext()` itself for the merchant-
 * scoped auth check - the layout separately reads the operator's identity
 * and merchant (Phase 28C addition: via the same, unmodified
 * `resolveMerchantAccess()` every page already trusts - no new
 * authorization concept) purely to decide what CHROME to show (the Demo
 * Workspace banner, the Razorpay connection-state line) - never to gate
 * access, which remains entirely each page's own responsibility. By the
 * time this layout renders real content, a child page has already
 * redirected any unauthenticated request to /login.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await authenticateOperator();
  const access = session ? await resolveMerchantAccess(session.operator.id) : null;

  const isDemo = access?.merchantId === DEMO_MERCHANT_ID;
  const razorpayState: RazorpayConnectionState | null = access
    ? resolveRazorpayConnectionState(access.merchantId)
    : null;

  return (
    <AppShell operatorEmail={session?.operator.email ?? null} isDemo={isDemo} razorpayState={razorpayState}>
      {children}
    </AppShell>
  );
}
