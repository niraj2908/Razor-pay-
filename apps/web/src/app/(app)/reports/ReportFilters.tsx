"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { DownloadIcon } from "@/lib/design/icons";

/**
 * Reports date-range filter + export links (Phase 28C). `since`/`until`
 * are the same `overviewService.ts` query params every other date-ranged
 * view already validates server-side - this form only builds the URL, the
 * page (and the export route, independently) re-validates on the server.
 * Export links carry the CURRENT filter state, so what a user exports
 * always matches what they're looking at on screen.
 */
export function ReportFilters({ since, until }: { since: string; until: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sinceValue, setSinceValue] = useState(since);
  const [untilValue, setUntilValue] = useState(until);

  function applyRange(e: React.FormEvent) {
    e.preventDefault();
    const params = new URLSearchParams(searchParams.toString());
    if (sinceValue) params.set("since", sinceValue);
    else params.delete("since");
    if (untilValue) params.set("until", untilValue);
    else params.delete("until");
    router.push(`/reports?${params.toString()}`);
  }

  const exportParams = new URLSearchParams();
  if (sinceValue) exportParams.set("since", sinceValue);
  if (untilValue) exportParams.set("until", untilValue);

  return (
    <form onSubmit={applyRange} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted text-xs">From</span>
        <input
          type="date"
          value={sinceValue}
          onChange={(e) => setSinceValue(e.target.value)}
          className="border-border bg-surface text-fg h-8 rounded-md border px-2 text-sm"
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-fg-muted text-xs">To</span>
        <input
          type="date"
          value={untilValue}
          onChange={(e) => setUntilValue(e.target.value)}
          className="border-border bg-surface text-fg h-8 rounded-md border px-2 text-sm"
        />
      </label>
      <Button type="submit" size="sm" variant="secondary">
        Apply
      </Button>
      <div className="ml-2 flex items-center gap-3 border-l pl-3">
        <a
          href={`/api/reports/export?format=csv&${exportParams.toString()}`}
          className="text-info flex items-center gap-1.5 text-sm font-medium hover:underline"
        >
          <DownloadIcon aria-hidden="true" className="h-3.5 w-3.5" />
          Export CSV
        </a>
        <a
          href={`/api/reports/export?format=pdf&${exportParams.toString()}`}
          className="text-info flex items-center gap-1.5 text-sm font-medium hover:underline"
        >
          <DownloadIcon aria-hidden="true" className="h-3.5 w-3.5" />
          Export PDF
        </a>
      </div>
    </form>
  );
}
