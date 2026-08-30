/**
 * Horizontal comparison bars (Phase 26 visual pass) - one row per real
 * value, bar length proportional to the group's own max. Every value is
 * printed as text next to its bar (never hover-only), so the comparison
 * reads correctly even with no pointer and needs no separate a11y
 * fallback table - this IS the accessible representation.
 *
 * `className` supplies the bar's fill color per item - callers pass a real
 * domain color (e.g. `bg-recovery-natural`, `bg-treatment`), never an
 * arbitrary decorative hue, so the color always carries the same meaning
 * it has everywhere else in the product.
 */
export type ComparisonBarItem = {
  label: string;
  value: number;
  displayValue: string;
  className: string;
};

export function ComparisonBar({ items, maxValue }: { items: ComparisonBarItem[]; maxValue?: number }) {
  const max = maxValue ?? Math.max(1, ...items.map((item) => item.value));

  return (
    <div className="flex flex-col gap-3">
      {items.map((item, i) => {
        const widthPct = max > 0 ? Math.max((item.value / max) * 100, item.value > 0 ? 3 : 0) : 0;
        return (
          <div key={i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-fg-secondary font-medium">{item.label}</span>
              <span className="text-fg font-mono text-sm font-medium tabular-nums">{item.displayValue}</span>
            </div>
            <div className="bg-surface-subtle h-2 w-full overflow-hidden rounded-sm">
              <div className={`h-full rounded-sm ${item.className}`} style={{ width: `${widthPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
