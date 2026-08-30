import type { ReactNode } from "react";
import { authenticateOperator } from "@/lib/auth/authenticateOperator";
import { AppShell } from "@/components/shell/AppShell";

/**
 * Layout for every authenticated route (Phase 26 Phase C). Each page under
 * this group still calls `requireAuthContext()` itself for the merchant-
 * scoped auth check - the layout separately reads just the operator's own
 * identity (no merchant resolution needed here) so the sidebar can show
 * real "signed in as" text instead of a placeholder. By the time this
 * layout renders real content, a child page has already redirected any
 * unauthenticated request to /login.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await authenticateOperator();
  return <AppShell operatorEmail={session?.operator.email ?? null}>{children}</AppShell>;
}
