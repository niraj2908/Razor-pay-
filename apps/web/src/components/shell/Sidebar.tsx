"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./LogoutButton";
import { OverviewIcon, RecoveryIcon, ExperimentIcon, AssistantIcon, ConnectedIcon, PendingIcon, ReportsIcon, SecurityIcon, AuditIcon } from "@/lib/design/icons";
import type { RazorpayConnectionState } from "@/lib/razorpay/connectionStatus";

/**
 * Primary product navigation (Phase 26 Phase B RESET, icon language added
 * in the Phase C visual pass).
 *
 * The first pass had a separate full-width TopBar carrying only the
 * product name above this sidebar - the exact "sidebar + topbar + title"
 * redundant stack the design brief singled out as the anti-pattern to
 * avoid. This version folds product identity into the sidebar's own
 * header instead, and the operator/account context into its own footer
 * (a Linear/Notion-style convention) - there is no separate TopBar
 * component anymore (see AppShell).
 *
 * Active state is a left accent border + a subtle tinted background (never
 * a filled/loud pill) + darker text weight - `--color-info` is reused here
 * as the ONE interactive nav accent, matching links and focus rings
 * everywhere else in the system.
 */

export const NAV_ITEMS = [
  { href: "/overview", label: "Overview", icon: OverviewIcon },
  { href: "/recovery", label: "Recovery", icon: RecoveryIcon },
  { href: "/experiments", label: "Experiments", icon: ExperimentIcon },
  { href: "/reports", label: "Reports", icon: ReportsIcon },
  { href: "/audit", label: "Audit", icon: AuditIcon },
  { href: "/security", label: "Security & Policies", icon: SecurityIcon },
] as const;

/**
 * The badge states what is true of THIS workspace without letting that be
 * read as a statement about the project. "Not configured" alone said the
 * former and implied the latter - a visitor in the synthetic Demo Workspace
 * saw it and could reasonably conclude no Razorpay integration existed,
 * when in fact it is implemented and configured for this deployment; the
 * Demo is simply, deliberately, not the workspace bound to it.
 */
const RAZORPAY_BADGE: Record<RazorpayConnectionState["status"], { label: string; note: string | null }> = {
  connected: { label: "Test Mode connected", note: null },
  configured_other_workspace: {
    label: "Test Mode configured",
    // Deliberately workspace-NEUTRAL. This state covers the synthetic Demo
    // Workspace and every self-signed-up merchant alike, so it must not
    // describe the data as synthetic - that is true of the Demo only, and
    // the Demo already says so in its own banner above every page.
    note: "Bound to a separate workspace",
  },
  not_configured: { label: "Not configured", note: null },
};

export function Sidebar({
  operatorEmail,
  razorpayState = null,
}: {
  operatorEmail: string | null;
  razorpayState?: RazorpayConnectionState | null;
}) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <RecoveryIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <span className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery</span>
      </div>

      <div className="flex-1 px-2 py-4">
        <div className="text-fg-muted px-2 pb-2 text-[11px] font-medium tracking-wider uppercase">Workspace</div>
        <nav aria-label="Primary" className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "flex items-center gap-2 rounded-r-sm border-l-2 px-3 py-1.5 text-[13px] transition-colors duration-150",
                  isActive
                    ? "border-info bg-info/[0.06] text-fg font-medium"
                    : "text-fg-secondary hover:text-fg hover:bg-surface-subtle border-transparent font-normal",
                ].join(" ")}
              >
                <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${isActive ? "text-info" : "text-fg-muted"}`} />
                {item.label}
              </Link>
            );
          })}
          {/* AI Operational Assistant (Phase 28C): now a real, working entry
              point - a deterministic, read-only, evidence-grounded Q&A
              surface (see assistantService.ts's own doc comment for why it
              is not a generative chatbot), not a placeholder. Kept visually
              distinct (a top border, slight vertical separation) from the
              three primary workflow screens above it - it is a supporting
              tool, not a fourth peer navigation destination. */}
          <Link
            href="/assistant"
            aria-current={pathname === "/assistant" || pathname?.startsWith("/assistant/") ? "page" : undefined}
            className={[
              "border-border mt-2 flex items-center gap-2 rounded-r-sm border-t border-l-2 px-3 pt-2.5 pb-1.5 text-[13px] transition-colors duration-150",
              pathname === "/assistant" || pathname?.startsWith("/assistant/")
                ? "border-l-info bg-info/[0.06] text-fg font-medium"
                : "text-fg-secondary hover:text-fg hover:bg-surface-subtle border-l-transparent font-normal",
            ].join(" ")}
          >
            <AssistantIcon aria-hidden="true" className={`h-4 w-4 shrink-0 ${pathname === "/assistant" ? "text-info" : "text-fg-muted"}`} />
            AI Assistant
          </Link>
        </nav>
      </div>

      <div className="border-border flex flex-col gap-1.5 border-t px-4 py-3">
        {razorpayState ? (
          <Link href="/security" className="flex flex-col gap-0.5 hover:underline">
            <span className="text-fg-muted flex items-center gap-1.5 text-[11px]">
              {razorpayState.status === "not_configured" ? (
                <PendingIcon aria-hidden="true" className="h-3 w-3 shrink-0" />
              ) : (
                <ConnectedIcon aria-hidden="true" className="text-success h-3 w-3 shrink-0" />
              )}
              Razorpay: {RAZORPAY_BADGE[razorpayState.status].label}
            </span>
            {RAZORPAY_BADGE[razorpayState.status].note ? (
              <span className="text-fg-muted pl-[18px] text-[11px]">{RAZORPAY_BADGE[razorpayState.status].note}</span>
            ) : null}
          </Link>
        ) : null}
        <span className="text-fg-secondary truncate text-xs">{operatorEmail ?? "Not signed in"}</span>
        {operatorEmail ? <LogoutButton /> : null}
      </div>
    </div>
  );
}
