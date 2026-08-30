"use client";

import { useRouter, useSearchParams } from "next/navigation";

/**
 * Recovery Queue filter bar (Phase 26, second visual pass). `status` and
 * `decisionType` are both real, already-supported query params on
 * `listRecoveryQueue` - `decisionType` was a genuine backend capability
 * left unexposed in the first visual pass; this is the "stronger
 * filter/action bar" the redesign brief asked for, added only because the
 * capability already exists server-side, not invented for this pass.
 * `diagnosis` remains deferred - six values would crowd this bar for a
 * dimension operators filter by far less often than decision type.
 *
 * Changing either filter navigates to a new server-rendered URL and always
 * drops the existing cursor and the other filter's current value is
 * preserved - a filter change always restarts pagination from page one.
 */
const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
] as const;

const DECISION_OPTIONS = [
  { value: "", label: "All decisions" },
  { value: "ACT", label: "Act" },
  { value: "WAIT", label: "Wait" },
  { value: "STOP", label: "Stop" },
  { value: "ESCALATE", label: "Escalate" },
] as const;

export function QueueFilters({ status, decisionType }: { status: string; decisionType: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(key: "status" | "decisionType", value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("cursor");
    router.push(`/recovery?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-fg-muted">Status</span>
        <select
          value={status}
          onChange={(e) => handleChange("status", e.target.value)}
          className="border-border bg-surface text-fg h-8 rounded-md border px-2 text-sm"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <span className="text-fg-muted">Decision</span>
        <select
          value={decisionType}
          onChange={(e) => handleChange("decisionType", e.target.value)}
          className="border-border bg-surface text-fg h-8 rounded-md border px-2 text-sm"
        >
          {DECISION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
