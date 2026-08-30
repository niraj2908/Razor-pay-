import type { ReactNode } from "react";
import type { IconComponent } from "@/lib/design/icons";

/**
 * In-content page header (Phase 26 Phase B RESET), replacing the removed
 * full-width TopBar. Lives inside a page's own content area, next to the
 * data it introduces, instead of floating in a separate chrome bar that
 * repeats the product name above an already-labeled sidebar.
 *
 * Deliberately plain: a title, an optional one-line description, and an
 * optional right-aligned actions slot - no card, no border, no
 * background. The page's own content establishes hierarchy below it via a
 * divider, not a boxed header.
 *
 * `icon` (Phase 26 visual pass) is the same concept icon shown for this
 * section in Sidebar/MobileNav - a small tinted square, the same treatment
 * used for the sidebar's own brand mark, so the icon language stays
 * coherent from nav to page.
 *
 * Stacks to a column below `sm` (title/description block, then actions
 * full-width beneath it) rather than forcing both onto one row - an
 * actions slot wide enough to hold a multi-filter bar (Recovery Queue's
 * status + decision filters) would otherwise overflow the viewport on
 * mobile instead of wrapping, since `shrink-0` on the actions block
 * prevented it from ever moving to its own line.
 */
export type PageHeaderProps = {
  title: string;
  description?: string;
  icon?: IconComponent;
  actions?: ReactNode;
};

export function PageHeader({ title, description, icon: Icon, actions }: PageHeaderProps) {
  return (
    <div className="border-border flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        {Icon ? (
          <span className="bg-info/10 text-info mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-sm">
            <Icon aria-hidden="true" weight="bold" className="h-4 w-4" />
          </span>
        ) : null}
        <div>
          <h1 className="text-fg text-xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-fg-secondary mt-1 text-sm">{description}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2 sm:shrink-0">{actions}</div> : null}
    </div>
  );
}
