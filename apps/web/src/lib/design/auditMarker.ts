import type { ExecutionStatus, OutcomeStatus, RecoveryDecision } from "@prisma/client";
import type { AuditEventDTO } from "@/lib/recovery/decisionAuditService";
import { DECISION_STATUS, EXECUTION_STATUS, OUTCOME_STATUS, type StatusDescriptor } from "./status";
import { PendingIcon } from "./icons";

/**
 * Derives a real status marker (icon/tone/label) for one audit event from
 * its OWN already-sanitized fields - never a generic per-entity-type
 * placeholder. Originally written for the per-decision Audit Trail page
 * (`recovery/[decisionId]/audit/page.tsx`, which keeps its own copy
 * unchanged rather than risk touching tested code); extracted here (Phase
 * 28C) once a second and third caller needed the identical logic
 * (Overview's Recovery Activity feed, the merchant-wide Audit page) - same
 * "never guess, only derive from the event's own real fields" rule.
 */
export function resolveAuditMarker(event: AuditEventDTO): StatusDescriptor {
  if (event.entityType === "Decision") {
    const action = event.details.selectedAction;
    if (typeof action === "string" && action in DECISION_STATUS) {
      return DECISION_STATUS[action as RecoveryDecision];
    }
  }
  if (event.entityType === "Execution") {
    const verb = event.action.split(".")[1]?.toUpperCase();
    if (verb && verb in EXECUTION_STATUS) {
      return EXECUTION_STATUS[verb as ExecutionStatus];
    }
  }
  if (event.entityType === "Outcome") {
    const status = event.details.outcomeStatus;
    if (typeof status === "string" && status in OUTCOME_STATUS) {
      return OUTCOME_STATUS[status as OutcomeStatus];
    }
  }
  return { label: event.entityType, tone: "neutral", icon: PendingIcon };
}
