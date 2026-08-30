"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./LogoutButton";
import { OverviewIcon, RecoveryIcon, ExperimentIcon } from "@/lib/design/icons";

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
] as const;

export function Sidebar({ operatorEmail }: { operatorEmail: string | null }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <RecoveryIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
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
                <Icon aria-hidden="true" weight={isActive ? "bold" : "regular"} className={`h-4 w-4 shrink-0 ${isActive ? "text-info" : "text-fg-muted"}`} />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="border-border flex flex-col gap-1 border-t px-4 py-3">
        <span className="text-fg-secondary truncate text-xs">{operatorEmail ?? "Not signed in"}</span>
        {operatorEmail ? <LogoutButton /> : null}
      </div>
    </div>
  );
}
