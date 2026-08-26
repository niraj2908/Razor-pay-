import { RecoveryDecisionTrace } from "./decisionEngine";

export type RecoveryAuditEvent = {
  decisionId: string;
  paymentId: string;
  selectedAction: string;
  selectedStrategy: string | null;
  policyVersion: string;
  modelVersion: string;
  reason: string;
  timestamp: string;
};

/**
 * Shapes a decision trace into the audit record required by Phase 21.13.
 * Deliberately narrower than the full trace (no candidate strategies, no
 * expected-value breakdown) - just the fields the audit trail needs. Never
 * includes a secret or credential.
 */
export function buildRecoveryAuditEvent(trace: RecoveryDecisionTrace): RecoveryAuditEvent {
  return {
    decisionId: trace.decisionId,
    paymentId: trace.paymentId,
    selectedAction: trace.selectedAction,
    selectedStrategy: trace.selectedStrategy,
    policyVersion: trace.policyVersion,
    modelVersion: trace.modelVersion,
    reason: trace.reason,
    timestamp: trace.timestamp,
  };
}
