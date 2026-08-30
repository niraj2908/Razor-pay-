import { resolveMoneyDisplay, type MoneyValue } from "@/lib/design/money";

/**
 * Renders a financial figure (Phase 26 Phase B RESET). All formatting/
 * display logic lives in `lib/design/money.ts` - this component only
 * applies typography: real amounts get tabular, monospace figures (IBM
 * Plex Mono) so columns of numbers align; unavailable/unknown values are
 * muted italic body text, deliberately NOT monospace, so they never look
 * like a real (if oddly formatted) number.
 *
 * At `lg` (the hero-metric size), the decimal portion is rendered smaller
 * and lighter than the rupee amount - a standard financial-statement
 * convention (the whole-rupee figure is what a reader scans for; paise
 * precision is secondary) that also gives large numbers a more
 * authoritative, less "dashboard widget" silhouette than a single flat
 * font size.
 */

export type MoneyProps = {
  value: MoneyValue;
  /** Visual size - "lg" for a hero metric, "sm" for a dense table cell. */
  size?: "sm" | "md" | "lg";
};

const SIZE_CLASSES: Record<NonNullable<MoneyProps["size"]>, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-[32px] leading-none tracking-tight",
};

function splitWholeAndDecimal(text: string): [string, string] | null {
  const match = /^(.*)(\.\d{2})$/.exec(text);
  if (!match) return null;
  return [match[1], match[2]];
}

export function Money({ value, size = "md" }: MoneyProps) {
  const display = resolveMoneyDisplay(value);
  const sizeClass = SIZE_CLASSES[size];

  if (!display.isAmount) {
    return (
      <span className={`text-fg-muted italic ${size === "lg" ? "text-xl" : sizeClass}`} aria-label={display.ariaLabel}>
        {display.text}
      </span>
    );
  }

  if (size === "lg") {
    const parts = splitWholeAndDecimal(display.text);
    if (parts) {
      const [whole, decimal] = parts;
      return (
        <span className={`font-mono tabular-nums text-fg ${sizeClass}`} aria-label={display.ariaLabel}>
          {whole}
          <span className="text-fg-muted text-[20px]">{decimal}</span>
        </span>
      );
    }
  }

  return (
    <span className={`font-mono tabular-nums text-fg ${sizeClass}`} aria-label={display.ariaLabel}>
      {display.text}
    </span>
  );
}
