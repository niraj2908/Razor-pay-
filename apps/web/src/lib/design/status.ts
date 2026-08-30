import type { ExecutionStatus, ExperimentStatus, MeasurementResultStatus, OutcomeStatus, RecoveryDecision } from "@prisma/client";
import {
  ActIcon,
  WaitIcon,
  StopIcon,
  EscalateIcon,
  SuccessIcon,
  FailureIcon,
  PendingIcon,
  EscalateIcon as WarningStatusIcon,
  RunningIcon,
  PausedIcon,
  type IconComponent,
} from "./icons";

/**
 * Status -> {label, tone, icon} maps (Phase 26 Phase C visual pass).
 *
 * Built directly against the real backend enum types (`RecoveryDecision`,
 * `MeasurementResultStatus`, `ExecutionStatus`, `OutcomeStatus` from
 * `@prisma/client`) rather than a hand-typed string union - if the backend
 * enum ever changes, this file fails to typecheck instead of silently
 * drifting out of sync with what the API can actually return.
 *
 * `tone` and `icon` never ARE the sole communication - StatusBadge always
 * renders `label` text alongside them: status must never depend on color or
 * icon shape alone (icons here are always paired with a Phosphor `Icon`
 * component, rendered `aria-hidden` next to the real text label).
 */

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export type StatusDescriptor = { label: string; tone: StatusTone; icon: IconComponent };

export const DECISION_STATUS: Record<RecoveryDecision, StatusDescriptor> = {
  ACT: { label: "Act", tone: "success", icon: ActIcon },
  WAIT: { label: "Wait", tone: "info", icon: WaitIcon },
  STOP: { label: "Stop", tone: "danger", icon: StopIcon },
  ESCALATE: { label: "Escalate", tone: "warning", icon: EscalateIcon },
};

export const EXECUTION_STATUS: Record<ExecutionStatus, StatusDescriptor> = {
  PENDING: { label: "Pending", tone: "neutral", icon: PendingIcon },
  SUCCEEDED: { label: "Succeeded", tone: "success", icon: SuccessIcon },
  FAILED: { label: "Failed", tone: "danger", icon: FailureIcon },
  AMBIGUOUS: { label: "Ambiguous", tone: "warning", icon: WarningStatusIcon },
};

export const OUTCOME_STATUS: Record<OutcomeStatus, StatusDescriptor> = {
  PENDING: { label: "Pending", tone: "neutral", icon: PendingIcon },
  RECOVERED: { label: "Recovered", tone: "success", icon: SuccessIcon },
  NOT_RECOVERED: { label: "Not recovered", tone: "danger", icon: FailureIcon },
};

export const MEASUREMENT_STATUS: Record<MeasurementResultStatus, StatusDescriptor> = {
  VALID_EFFECT: { label: "Valid effect", tone: "success", icon: SuccessIcon },
  VALID_INCONCLUSIVE: { label: "Inconclusive", tone: "warning", icon: WarningStatusIcon },
  INVALID: { label: "Invalid", tone: "danger", icon: FailureIcon },
  INSUFFICIENT_DATA: { label: "Insufficient data", tone: "neutral", icon: PendingIcon },
};

export const EXPERIMENT_STATUS: Record<ExperimentStatus, StatusDescriptor> = {
  DRAFT: { label: "Draft", tone: "neutral", icon: PendingIcon },
  RUNNING: { label: "Running", tone: "info", icon: RunningIcon },
  PAUSED: { label: "Paused", tone: "warning", icon: PausedIcon },
  COMPLETED: { label: "Completed", tone: "success", icon: SuccessIcon },
};
