# services/decision-engine

The Policy layer (Section 25): deterministic economic + safety decisioning.

Owns:
- Economic decision model (Section 9): Expected Net Value calculation
- Safety state machine (Section 10): unknown state is always safer than wrong action
- Four core decisions (Section 8): ACT / WAIT / STOP / ESCALATE
- Guardrail/policy checks against MerchantPolicy records

This service must never call an LLM for a financial decision (Section 15, ADR-004).
