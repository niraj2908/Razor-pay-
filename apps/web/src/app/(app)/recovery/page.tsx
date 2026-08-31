import Link from "next/link";
import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import {
  isValidStatusFilter,
  isValidDecisionType,
  listRecoveryQueue,
  type RecoveryQueueItem,
} from "@/lib/recovery/recoveryQueueService";
import { PageHeader } from "@/components/ui/PageHeader";
import { Money } from "@/components/ui/Money";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Timestamp } from "@/components/ui/Timestamp";
import { MiniProbabilityBar } from "@/components/ui/MiniProbabilityBar";
import { DECISION_STATUS } from "@/lib/design/status";
import { humanizeEnumValue } from "@/lib/design/text";
import { RecoveryIcon } from "@/lib/design/icons";
import { QueueFilters } from "./QueueFilters";

/**
 * Recovery Queue - the operational workbench (Phase 26, second visual
 * pass). Full-width, genuinely used: two probability columns
 * (`naturalRecoveryProbability`, `chosenAction.predictedSuccessProbability`)
 * that existed in the API since the first pass but had no visual
 * treatment now get their own columns with a compact inline bar, rather
 * than stretching the existing five columns to fill space. A real
 * `<table>` at `sm:` and above; below that, a stacked representation
 * designed for the small screen rather than a shrunken table.
 *
 * `decisionType` joins `status` in the filter bar - both are real,
 * already-supported `listRecoveryQueue` query params; `diagnosis` stays
 * deferred (see QueueFilters' own doc comment).
 */
export default async function RecoveryQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; decisionType?: string; cursor?: string }>;
}) {
  const { merchantId } = await requireAuthContext();
  const params = await searchParams;

  const status = isValidStatusFilter(params.status) ? params.status : "open";
  const decisionType = isValidDecisionType(params.decisionType) ? params.decisionType : undefined;
  // Highest amount at risk first. `listRecoveryQueue`'s own default is
  // oldest-detected-first, which is a reasonable API default but the wrong
  // one for a triage screen: with a large cohort of similar low-value
  // candidates it fills the entire first page with near-identical rows and
  // buries both the highest-value work and the decision-type variety. An
  // operator opening this queue should see the biggest money first.
  // Passed explicitly here rather than changing the service default, so the
  // API contract every other caller relies on is untouched.
  const result = await listRecoveryQueue(merchantId, {
    status,
    decisionType,
    sort: "amountAtRisk_desc",
    cursor: params.cursor,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Recovery queue"
        description="Revenue-at-risk situations and the decisions made about them."
        icon={RecoveryIcon}
        actions={<QueueFilters status={status} decisionType={decisionType ?? ""} />}
      />

      {result.items.length === 0 ? (
        <p className="text-fg-muted py-8 text-center text-sm italic">No matching recovery candidates.</p>
      ) : (
        <>
          {/* Desktop/tablet table */}
          <div className="hidden overflow-x-auto sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-border text-fg-muted border-b text-left text-[11px] font-medium tracking-wider whitespace-nowrap uppercase">
                  <th className="py-2 pr-4 font-medium">Detected</th>
                  <th className="py-2 pr-4 font-medium">Diagnosis</th>
                  <th className="py-2 pr-4 font-medium">Recovery probability</th>
                  <th className="py-2 pr-4 text-right font-medium">Amount at risk</th>
                  <th className="py-2 pr-4 font-medium">Decision</th>
                  <th className="py-2 pr-4 font-medium">Recommended action</th>
                  <th className="py-2 font-medium">Predicted success</th>
                </tr>
              </thead>
              <tbody className="divide-border divide-y">
                {result.items.map((item) => (
                  <QueueRow key={item.id} item={item} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked representation */}
          <ul className="divide-border flex flex-col divide-y sm:hidden">
            {result.items.map((item) => (
              <QueueRowMobile key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}

      {result.nextCursor ? (
        <div className="pt-2">
          <Link
            href={`/recovery?status=${status}${decisionType ? `&decisionType=${decisionType}` : ""}&cursor=${result.nextCursor}`}
            className="text-info text-sm font-medium hover:underline"
          >
            Next page &rarr;
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A row's primary identifying cell (diagnosis) is the link to its decision
 * detail - a plain, valid, accessible pattern (one real `<a>` per row)
 * rather than an absolute-positioned "whole row is clickable" hack layered
 * on top of `<table>` markup. A candidate with no decision yet has nothing
 * to link to - it renders as a plain, non-interactive row.
 */
function QueueRow({ item }: { item: RecoveryQueueItem }) {
  return (
    <tr className="hover:bg-surface-subtle text-sm">
      <td className="py-3 pr-4 whitespace-nowrap">
        <Timestamp iso={item.detectedAt} className="text-fg-secondary text-sm" />
      </td>
      <td className="py-3 pr-4 whitespace-nowrap">
        {item.decision ? (
          <Link href={`/recovery/${item.decision.id}`} className="text-info font-medium hover:underline">
            {humanizeEnumValue(item.diagnosis)}
          </Link>
        ) : (
          <span className="text-fg">{humanizeEnumValue(item.diagnosis)}</span>
        )}
      </td>
      <td className="py-3 pr-4 whitespace-nowrap">
        {item.naturalRecoveryProbability !== null ? (
          <MiniProbabilityBar value={item.naturalRecoveryProbability} className="bg-recovery-natural" />
        ) : (
          <span className="text-fg-muted">&mdash;</span>
        )}
      </td>
      <td className="py-3 pr-4 text-right whitespace-nowrap">
        <Money value={{ kind: "amount", paise: item.amountAtRiskPaise }} size="sm" />
      </td>
      <td className="py-3 pr-4 whitespace-nowrap">
        {item.decision ? (
          <StatusBadge {...DECISION_STATUS[item.decision.decisionType]} />
        ) : (
          <span className="text-fg-muted italic">Awaiting decision</span>
        )}
      </td>
      <td className="py-3 pr-4 whitespace-nowrap">
        {item.decision?.chosenAction ? (
          <span className="text-fg-secondary">{humanizeEnumValue(item.decision.chosenAction.actionType)}</span>
        ) : (
          <span className="text-fg-muted">&mdash;</span>
        )}
      </td>
      <td className="py-3 whitespace-nowrap">
        {item.decision?.chosenAction ? (
          <MiniProbabilityBar value={item.decision.chosenAction.predictedSuccessProbability} className="bg-recovery-intervention" />
        ) : (
          <span className="text-fg-muted">&mdash;</span>
        )}
      </td>
    </tr>
  );
}

function QueueRowMobile({ item }: { item: RecoveryQueueItem }) {
  const body = (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <span className={`text-sm font-medium ${item.decision ? "text-info" : "text-fg"}`}>
          {humanizeEnumValue(item.diagnosis)}
        </span>
        <Money value={{ kind: "amount", paise: item.amountAtRiskPaise }} size="sm" />
      </div>
      {item.naturalRecoveryProbability !== null ? (
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-fg-muted">Recovery probability</span>
          <MiniProbabilityBar value={item.naturalRecoveryProbability} className="bg-recovery-natural" />
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <Timestamp iso={item.detectedAt} className="text-fg-muted text-xs" />
        {item.decision ? (
          <StatusBadge {...DECISION_STATUS[item.decision.decisionType]} />
        ) : (
          <span className="text-fg-muted text-xs italic">Awaiting decision</span>
        )}
      </div>
    </div>
  );

  if (!item.decision) {
    return <li>{body}</li>;
  }

  return (
    <li>
      <Link href={`/recovery/${item.decision.id}`} className="block">
        {body}
      </Link>
    </li>
  );
}
