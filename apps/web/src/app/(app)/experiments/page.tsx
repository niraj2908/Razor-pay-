import Link from "next/link";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { isValidExperimentStatus, listExperiments } from "@/lib/experiments/measurement/experimentQueryService";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { EXPERIMENT_STATUS } from "@/lib/design/status";
import { ExperimentIcon } from "@/lib/design/icons";

/**
 * Experiments list (Phase 26 Phase C, screen 6). Only fields `listExperiments`
 * actually returns - id, name, status, version, startedAt, endedAt,
 * createdAt. No performance/result summary is shown here (that would mean
 * fetching every experiment's measurement result just for a list row -
 * not something the API is shaped to do cheaply, and results belong on the
 * detail page where the full statistical context lives).
 */
export default async function ExperimentsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; cursor?: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const params = await searchParams;
  const status = isValidExperimentStatus(params.status) ? params.status : undefined;

  const result = await listExperiments(merchantId, { status, cursor: params.cursor });

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <PageHeader title="Experiments" description="Randomized recovery experiments and their measurement results." icon={ExperimentIcon} />

      {result.items.length === 0 ? (
        <p className="text-fg-muted py-8 text-center text-sm italic">No experiments configured for this merchant yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-border text-fg-muted border-b text-left text-[11px] font-medium tracking-wider uppercase">
              <th className="py-2 pr-4 font-medium">Name</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 font-medium">Version</th>
              <th className="py-2 pr-4 font-medium">Started</th>
              <th className="py-2 font-medium">Ended</th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {result.items.map((experiment) => (
              <tr key={experiment.id} className="hover:bg-surface-subtle">
                <td className="py-3 pr-4">
                  <Link href={`/experiments/${experiment.id}`} className="text-fg font-medium hover:underline">
                    {experiment.name}
                  </Link>
                </td>
                <td className="py-3 pr-4">
                  <StatusBadge {...EXPERIMENT_STATUS[experiment.status]} />
                </td>
                <td className="text-fg-secondary py-3 pr-4">{experiment.version}</td>
                <td className="py-3 pr-4">{experiment.startedAt ? <Timestamp iso={experiment.startedAt} /> : <span className="text-fg-muted">Not started</span>}</td>
                <td className="py-3">{experiment.endedAt ? <Timestamp iso={experiment.endedAt} /> : <span className="text-fg-muted">Not ended</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {result.nextCursor ? (
        <div className="pt-2">
          <Link href={`/experiments?cursor=${result.nextCursor}`} className="text-info text-sm font-medium hover:underline">
            Next page &rarr;
          </Link>
        </div>
      ) : null}
    </div>
  );
}
