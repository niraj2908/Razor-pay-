/**
 * Single proportional segmented bar + legend (Phase 26 visual pass) - for
 * showing how a real total splits across a small number of real
 * categories (e.g. attributed-outcome composition). A zero total renders
 * an empty muted bar rather than a NaN-width segment - honest about
 * having nothing to show yet, never a fabricated split.
 *
 * Category is never encoded by color alone: the legend always pairs each
 * swatch with its label and real count/value as text.
 */
export type Segment = {
  label: string;
  value: number;
  displayValue: string;
  className: string;
};

export function SegmentedBar({ segments }: { segments: Segment[] }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="bg-surface-subtle flex h-3 w-full overflow-hidden rounded-sm">
        {total > 0
          ? segments
              .filter((s) => s.value > 0)
              .map((s, i) => (
                <div key={i} className={s.className} style={{ width: `${(s.value / total) * 100}%` }} />
              ))
          : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {segments.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-sm ${s.className}`} />
            <span className="text-fg-secondary">{s.label}</span>
            <span className="text-fg font-mono font-medium tabular-nums">{s.displayValue}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
