import { formatPercent } from "@/lib/design/percent";

/**
 * Confidence-interval range visualization (Phase 26 visual pass) - three
 * real numbers only (lower bound, point estimate, upper bound), all
 * already printed as text alongside the bar, never hover-only. A zero
 * reference tick makes "does this interval cross zero" (the difference
 * between a directional read and a genuinely inconclusive one) visible at
 * a glance, without stating a causal claim the interval itself doesn't
 * make.
 */
export function ConfidenceIntervalBar({ lower, point, upper, label }: { lower: number; point: number; upper: number; label: string }) {
  const span = Math.max(Math.abs(lower), Math.abs(upper), Math.abs(point), 0.01) * 1.25;
  const toPct = (v: number) => ((v + span) / (2 * span)) * 100;
  const bandLeft = toPct(Math.min(lower, upper));
  const bandRight = toPct(Math.max(lower, upper));
  const pointPct = toPct(point);
  const zeroPct = toPct(0);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative h-4 w-full">
        <div className="bg-border absolute top-1/2 right-0 left-0 h-px -translate-y-1/2" />
        <div
          className="bg-info/25 absolute top-1/2 h-1.5 -translate-y-1/2 rounded-sm"
          style={{ left: `${bandLeft}%`, width: `${Math.max(bandRight - bandLeft, 0.5)}%` }}
        />
        <div aria-hidden="true" className="bg-fg-muted absolute top-1/2 h-3 w-px -translate-y-1/2" style={{ left: `${zeroPct}%` }} />
        <div aria-hidden="true" className="bg-info absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${pointPct}%` }} />
      </div>
      <div className="text-fg-muted flex justify-between text-[11px]">
        <span className="font-mono tabular-nums">{formatPercent(lower)}</span>
        <span className="text-fg-secondary">{label}</span>
        <span className="font-mono tabular-nums">{formatPercent(upper)}</span>
      </div>
    </div>
  );
}
