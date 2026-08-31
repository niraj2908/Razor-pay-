"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Audit trail entity-type filter, following the same shape as the Recovery
 * queue's `QueueFilters`: a real, already-supported server capability
 * exposed in the UI, never a client-side illusion over a fixed list.
 *
 * This exists because the unfiltered trail is strictly chronological, and
 * outcomes are by definition the last thing to happen to any decision - so
 * the most recent page of a mature dataset is entirely `Outcome` rows, and
 * the decision and execution history the page's own description promises is
 * pushed off the end of the bounded window. Filtering by type is the honest
 * fix: it reorders nothing and hides nothing, it just lets the reader ask
 * for the slice they came for.
 */
const ENTITY_OPTIONS = [
  { value: "", label: "All activity" },
  { value: "Decision", label: "Decisions" },
  { value: "Execution", label: "Executions" },
  { value: "Outcome", label: "Outcomes" },
] as const;

export function AuditFilters({ entityType }: { entityType: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("entityType", value);
    } else {
      params.delete("entityType");
    }
    const query = params.toString();
    router.push(query ? `/audit?${query}` : "/audit");
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-fg-muted">Show</span>
      <select
        value={entityType}
        onChange={(e) => handleChange(e.target.value)}
        className="border-border bg-surface text-fg h-8 rounded-md border px-2 text-sm"
      >
        {ENTITY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
