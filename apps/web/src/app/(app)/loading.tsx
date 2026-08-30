/**
 * Route-segment loading state (Phase 26 Phase C, application-wide states
 * pass). Every page under this segment fetches its data directly from a
 * query service with no client-side loading state of its own - this is
 * the only thing shown while that fetch is in flight, via Next's
 * Suspense-backed loading convention. Sidebar/shell stay mounted; only the
 * content area shows this.
 */
export default function Loading() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="text-fg-muted flex items-center gap-2 text-sm">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
        Loading&hellip;
      </div>
    </div>
  );
}
