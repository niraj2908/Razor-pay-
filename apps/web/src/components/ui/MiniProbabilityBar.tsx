import { formatPercent } from "@/lib/design/percent";

/**
 * Inline compact probability indicator (Phase 26, second visual pass) -
 * for dense table cells where a full `ComparisonBar` would be too tall. A
 * short track + the exact percentage as text right beside it (never
 * color/length-only), used for real per-row probability fields that
 * existed in the API but had no visual treatment: natural recovery
 * probability, predicted action success probability.
 */
export function MiniProbabilityBar({ value, className }: { value: number; className: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="bg-surface-subtle inline-block h-1.5 w-10 overflow-hidden rounded-sm align-middle">
        <span className={`block h-full ${className}`} style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }} />
      </span>
      <span className="text-fg-muted font-mono text-[11px] tabular-nums">{formatPercent(value, 0)}</span>
    </span>
  );
}
