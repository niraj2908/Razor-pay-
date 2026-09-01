"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

/**
 * The operator's trigger for an ACT decision (the client half of
 * POST /api/recovery/decisions/[decisionId]/execute).
 *
 * Rendered only where the server already established that this decision is
 * an un-executed ACT - this component decides nothing, it only asks. Every
 * gate that matters (safety, policy, experiment CONTROL, staleness,
 * strategy support) is enforced server-side, so a caller reaching the
 * endpoint by any other route is checked identically.
 *
 * Refusals are shown verbatim rather than smoothed into "something went
 * wrong": "the decision is older than the execution window" is exactly
 * what an operator needs to know, and hiding it would make the safety
 * gates look like bugs.
 */

const REFUSAL_COPY: Record<string, string> = {
  decision_stale: "This decision is older than the execution window, so it can no longer be acted on. Recovery must be re-evaluated first.",
  control_arm_forbidden: "This candidate is in the experiment's control group and must never be intervened on.",
  unsupported_strategy: "Razorpay offers no API for the strategy this decision chose, so it cannot be executed.",
  decision_not_act: "Only an ACT decision can be executed.",
  no_chosen_action: "This decision has no chosen action to execute.",
  payment_missing: "The payment behind this decision could not be found.",
  payment_not_found: "The payment behind this decision could not be found.",
  action_not_executable: "Only an ACT decision can be executed.",
  invalid_amount: "The recovery amount on this decision is not valid.",
  missing_decision_id: "The decision reference is incomplete.",
  missing_payment_id: "The payment reference is incomplete.",
};

type Feedback = { tone: "ok" | "warn" | "error"; message: string };

export function ExecuteDecisionButton({ decisionId }: { decisionId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  async function run() {
    setPending(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/recovery/decisions/${decisionId}/execute`, {
        method: "POST",
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok && body.status === "succeeded") {
        setFeedback({ tone: "ok", message: `Recovery executed. Razorpay reference ${body.razorpayReferenceId}.` });
        router.refresh();
      } else if (response.ok && body.status === "existing") {
        setFeedback({ tone: "warn", message: "This decision was already executed - no second Razorpay call was made." });
        router.refresh();
      } else if (response.status === 202) {
        setFeedback({
          tone: "warn",
          message: "Razorpay did not confirm the result. The execution is recorded as ambiguous and must not be retried blindly.",
        });
        router.refresh();
      } else {
        const reason = typeof body.reason === "string" ? body.reason : null;
        setFeedback({
          tone: "error",
          message: (reason && REFUSAL_COPY[reason]) ?? "Execution did not complete. Nothing was charged.",
        });
        router.refresh();
      }
    } catch {
      // A network failure here is genuinely ambiguous: the request may have
      // reached the server. Say so rather than inviting a blind retry.
      setFeedback({
        tone: "warn",
        message: "The request could not be confirmed. Reload before trying again - the execution may already have started.",
      });
    } finally {
      setPending(false);
    }
  }

  const toneClass =
    feedback?.tone === "ok" ? "text-success" : feedback?.tone === "warn" ? "text-warning" : "text-danger";

  return (
    <div className="space-y-2">
      <Button onClick={run} loading={pending} disabled={pending} size="sm">
        {pending ? "Executing…" : "Execute recovery"}
      </Button>
      <p className="text-fg-muted text-xs">
        Sends the chosen action to Razorpay. Safety, policy and experiment controls are re-checked server-side.
      </p>
      {feedback ? (
        <p className={`text-xs ${toneClass}`} role="status">
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
