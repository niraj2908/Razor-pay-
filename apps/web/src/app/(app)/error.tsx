"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/Button";

/**
 * Route-segment error boundary (Phase 26 Phase C, application-wide states
 * pass). Catches an unexpected throw from a page or the query services it
 * calls - never a substitute for the honest per-field "unavailable" states
 * those services already return for expected data gaps. Copy stays
 * generic and non-alarming; the real error is logged, never shown to the
 * operator.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
      <p className="text-fg text-sm font-medium">Something went wrong loading this page.</p>
      <p className="text-fg-muted text-sm">No changes were made. You can try again.</p>
      <Button size="sm" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
