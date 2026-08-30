import Link from "next/link";

/**
 * Route-segment 404 (Phase 26 Phase C, application-wide states pass).
 * Reached whenever a page calls `notFound()` - an invalid decisionId,
 * experimentId, or a foreign-merchant id that resolves the same way as
 * nonexistent (see recovery/[decisionId]/page.tsx). Rendered nested inside
 * this segment's layout, so the sidebar stays reachable instead of the
 * operator landing on a bare, chrome-less 404.
 */
export default function NotFound() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
      <p className="text-fg text-sm font-medium">This page could not be found.</p>
      <Link href="/overview" className="text-info text-sm font-medium hover:underline">
        Go to Overview
      </Link>
    </div>
  );
}
