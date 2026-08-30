import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";

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
 */
export function AppShell({ children, operatorEmail }: { children: ReactNode; operatorEmail: string | null }) {
  return (
    <div className="bg-bg flex h-full min-h-screen">
      <aside className="border-border bg-surface hidden w-60 shrink-0 border-r md:block">
        <Sidebar operatorEmail={operatorEmail} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav operatorEmail={operatorEmail} />
        <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
