import type { ReactNode } from "react";
import type { StatusTone } from "@/lib/design/status";
import type { IconComponent } from "@/lib/design/icons";
import { TONE_BORDER, TONE_BG, TONE_ICON } from "@/lib/design/tone";

/**
 * Decision -> Execution -> Outcome lifecycle visualization (Phase 26
 * visual pass). A step whose data doesn't exist yet (`done: false`, e.g.
 * no Execution row) renders as an honest muted/pending node - never
 * skipped, never guessed into a fake "in progress" state.
 *
 * Two real layouts, not one CSS-reordered one: a horizontal row with
 * connecting lines at `sm:` and up, and a vertical list with a connecting
 * line at mobile - matching the same dual-render pattern already used for
 * the Recovery Queue's table/list. A cramped horizontal squeeze is not an
 * acceptable "mobile" treatment for a 3-node lifecycle.
 */
export type TimelineNode = {
  icon: IconComponent;
  label: string;
  sublabel?: ReactNode;
  tone: StatusTone;
  done: boolean;
};

export function ProcessTimeline({ nodes }: { nodes: TimelineNode[] }) {
  return (
    <>
      {/* Desktop/tablet: horizontal row */}
      <ol className="hidden items-start sm:flex">
        {nodes.map((node, i) => (
          <li key={i} className="flex flex-1 items-center">
            <div className="flex flex-1 flex-col items-center gap-2 text-center">
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 ${node.done ? TONE_BORDER[node.tone] : "border-border"} ${node.done ? TONE_BG[node.tone] : "bg-surface"}`}
              >
                <node.icon aria-hidden="true" weight="bold" className={`h-4 w-4 ${node.done ? TONE_ICON[node.tone] : "text-fg-muted"}`} />
              </span>
              <div>
                <div className={`text-xs font-semibold ${node.done ? "text-fg" : "text-fg-muted"}`}>{node.label}</div>
                {node.sublabel ? <div className="text-fg-muted mt-0.5 text-[11px]">{node.sublabel}</div> : null}
              </div>
            </div>
            {i < nodes.length - 1 ? (
              <div aria-hidden="true" className={`border-border mb-8 h-0 flex-1 border-t-2 ${nodes[i + 1].done ? "" : "border-dashed"}`} />
            ) : null}
          </li>
        ))}
      </ol>

      {/* Mobile: vertical list */}
      <ol className="flex flex-col sm:hidden">
        {nodes.map((node, i) => (
          <li key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2 ${node.done ? TONE_BORDER[node.tone] : "border-border"} ${node.done ? TONE_BG[node.tone] : "bg-surface"}`}
              >
                <node.icon aria-hidden="true" weight="bold" className={`h-4 w-4 ${node.done ? TONE_ICON[node.tone] : "text-fg-muted"}`} />
              </span>
              {i < nodes.length - 1 ? (
                <div aria-hidden="true" className={`border-border w-0 flex-1 border-l-2 ${nodes[i + 1].done ? "" : "border-dashed"}`} style={{ minHeight: "24px" }} />
              ) : null}
            </div>
            <div className="pb-6">
              <div className={`text-sm font-semibold ${node.done ? "text-fg" : "text-fg-muted"}`}>{node.label}</div>
              {node.sublabel ? <div className="text-fg-muted mt-0.5 text-xs">{node.sublabel}</div> : null}
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}
