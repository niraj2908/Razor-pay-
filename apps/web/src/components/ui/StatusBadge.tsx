import type { StatusTone } from "@/lib/design/status";
import type { IconComponent } from "@/lib/design/icons";

/**
 * Generic status indicator (Phase 26 Phase C visual pass).
 *
 * Status communicates through ICON + LABEL + COLOR together, never color
 * alone - a semantic Lucide icon (always `aria-hidden`, since the visible
 * text label already carries the meaning) replaces the plain dot used in
 * the Phase B reset wherever a caller has one. Callers with no real
 * semantic icon (e.g. an ad-hoc pass/fail check) still get the dot
 * fallback rather than being forced to invent one.
 */

const TONE_TEXT: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-fg-muted",
};

const TONE_DOT: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-fg-muted",
};

export type StatusBadgeProps = {
  label: string;
  tone: StatusTone;
  icon?: IconComponent;
  /** Optional supporting detail rendered after the label, e.g. a reason
   * code - kept visually secondary (muted) so the label remains the
   * primary read. */
  detail?: string;
};

export function StatusBadge({ label, tone, icon: Icon, detail }: StatusBadgeProps) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {Icon ? (
        <Icon aria-hidden="true" className={`h-3.5 w-3.5 shrink-0 ${TONE_TEXT[tone]}`} />
      ) : (
        <span aria-hidden="true" className={`h-[6px] w-[6px] shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      )}
      <span className={`font-medium ${TONE_TEXT[tone]}`}>{label}</span>
      {detail ? <span className="text-fg-muted">{detail}</span> : null}
    </span>
  );
}
