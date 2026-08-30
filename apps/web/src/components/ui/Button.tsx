import type { ButtonHTMLAttributes } from "react";

/**
 * Base button primitive (Phase 26 Phase B). Establishes the interaction-
 * state pattern (default/hover/focus/active/disabled/loading) every later
 * interactive component should follow - see Section 16 of the design
 * brief. No client-side state of its own; `loading` is caller-controlled
 * so this stays a plain Server Component.
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "sm" | "md";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-fg text-surface hover:bg-fg-secondary",
  secondary: "bg-surface text-fg border border-border hover:bg-surface-subtle",
  ghost: "bg-transparent text-fg-secondary hover:bg-surface-subtle",
  destructive: "bg-danger text-surface hover:opacity-90",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm",
  md: "h-10 px-4 text-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        className ?? "",
      ].join(" ")}
      {...rest}
    >
      {loading ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : null}
      {children}
    </button>
  );
}
