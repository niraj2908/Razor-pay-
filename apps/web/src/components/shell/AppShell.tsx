import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { DemoModeIcon } from "@/lib/design/icons";
import type { RazorpayConnectionState } from "@/lib/razorpay/connectionStatus";

/**
 * The authenticated-app frame (Phase 26 Phase B RESET, wired to real
 * operator identity in Phase C). No separate TopBar - identity lives once,
 * in the sidebar's own header; each page owns its own compact title via
 * PageHeader.
 *
 * Login renders OUTSIDE this shell entirely.
 *
 * Responsive foundation: the sidebar collapses away below the `md`
 * breakpoint via CSS; MobileNav takes over as the only way to reach
 * Overview/Recovery/Experiments below that width.
 *
 * `isDemo`/`razorpayState` (Phase 28C) are read-only chrome flags resolved
 * by the layout, never an authorization signal here - a single-line,
 * deliberately unobtrusive banner (one icon, one sentence, muted tone -
 * never a colorful hero strip) so the Demo Workspace is always honestly
 * identified without competing with real page content for attention.
 */
export function AppShell({
  children,
  operatorEmail,
  isDemo = false,
  razorpayState = null,
}: {
  children: ReactNode;
  operatorEmail: string | null;
  isDemo?: boolean;
  razorpayState?: RazorpayConnectionState | null;
}) {
  return (
    <div className="bg-bg flex h-full min-h-screen">
      <aside className="border-border bg-surface hidden w-60 shrink-0 border-r md:block">
        <Sidebar operatorEmail={operatorEmail} razorpayState={razorpayState} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav operatorEmail={operatorEmail} />
        {isDemo ? (
          <div className="border-info/20 bg-info/[0.04] text-fg-secondary flex items-center gap-2 border-b px-4 py-2 text-xs sm:px-8">
            <DemoModeIcon aria-hidden="true" className="text-info h-3.5 w-3.5 shrink-0" />
            <span>
              <span className="text-fg font-medium">Demo / Test Mode</span> — synthetic evaluation data, no real
              customer payments.
            </span>
          </div>
        ) : null}
        <main className="min-w-0 flex-1 px-6 py-6 sm:px-8">
          {/* A generous but real cap (Phase 28C full-screen pass) - below it,
              content genuinely uses the full viewport (a 1440-1920px
              operator display is the common case and gets essentially
              edge-to-edge content); above it, an operations console still
              reads better as a wide, dense document than as text stretched
              across a 2560px+ monitor with no limit at all. */}
          <div className="mx-auto max-w-[2000px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
