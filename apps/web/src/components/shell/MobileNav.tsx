"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogoutButton } from "./LogoutButton";
import { NAV_ITEMS } from "./Sidebar";
import { MenuIcon, RecoveryIcon } from "@/lib/design/icons";

/**
 * Mobile navigation affordance (Phase 26 Phase C, responsive pass). Below
 * `md`, AppShell hides the Sidebar entirely - this top bar is the only way
 * to reach Overview/Recovery/Experiments on a narrow viewport. A native
 * `<details>` disclosure needs no client state of its own for open/close;
 * this is still a Client Component only because active-link highlighting
 * needs `usePathname`, same as Sidebar.
 */
export function MobileNav({ operatorEmail }: { operatorEmail: string | null }) {
  const pathname = usePathname();

  return (
    <header className="border-border bg-surface flex h-14 shrink-0 items-center justify-between border-b px-4 md:hidden">
      <span className="flex items-center gap-2">
        <span className="bg-info/10 text-info flex h-6 w-6 shrink-0 items-center justify-center rounded-sm">
          <RecoveryIcon aria-hidden="true" weight="bold" className="h-3.5 w-3.5" />
        </span>
        <span className="text-fg text-sm font-semibold tracking-tight">Revenue Recovery</span>
      </span>
      <details key={pathname} className="relative">
        <summary className="text-fg-secondary flex cursor-pointer list-none items-center gap-1.5 text-[13px] font-medium">
          <MenuIcon aria-hidden="true" weight="regular" className="h-4 w-4" />
          Menu
        </summary>
        <nav
          aria-label="Primary"
          className="border-border bg-surface shadow-popover absolute right-0 z-10 mt-2 w-48 border py-2"
        >
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname?.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={[
                  "flex items-center gap-2 border-l-2 px-3 py-1.5 text-[13px]",
                  isActive
                    ? "border-info bg-info/[0.06] text-fg font-medium"
                    : "text-fg-secondary border-transparent font-normal",
                ].join(" ")}
              >
                <Icon aria-hidden="true" weight={isActive ? "bold" : "regular"} className={`h-4 w-4 shrink-0 ${isActive ? "text-info" : "text-fg-muted"}`} />
                {item.label}
              </Link>
            );
          })}
          <div className="border-border mt-2 flex flex-col gap-1 border-t px-3 pt-2">
            <span className="text-fg-secondary truncate text-xs">{operatorEmail ?? "Not signed in"}</span>
            {operatorEmail ? <LogoutButton /> : null}
          </div>
        </nav>
      </details>
    </header>
  );
}
