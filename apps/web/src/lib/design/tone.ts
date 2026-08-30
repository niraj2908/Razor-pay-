import type { StatusTone } from "./status";

/**
 * Shared StatusTone -> Tailwind class maps (Phase 26 visual pass). A
 * subtle tinted background (10% opacity) + matching border + matching
 * icon color - never a solid filled chip - used everywhere a tone needs
 * more visual weight than plain `StatusBadge` text (timeline nodes, audit
 * entity markers).
 */
export const TONE_BORDER: Record<StatusTone, string> = {
  success: "border-success",
  warning: "border-warning",
  danger: "border-danger",
  info: "border-info",
  neutral: "border-border",
};

export const TONE_BG: Record<StatusTone, string> = {
  success: "bg-success/10",
  warning: "bg-warning/10",
  danger: "bg-danger/10",
  info: "bg-info/10",
  neutral: "bg-surface-subtle",
};

export const TONE_ICON: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-fg-muted",
};
