import { requireAuthContext } from "@/lib/auth/requireAuthContext";
import { PageHeader } from "@/components/ui/PageHeader";
import { AssistantIcon } from "@/lib/design/icons";
import { AssistantPanel } from "./AssistantPanel";

/**
 * AI Operational Assistant (Phase 28C). A real, working, read-only,
 * evidence-grounded Q&A surface - deliberately NOT a generative chatbot
 * (no LLM credentials exist in this deployment; see `assistantService.ts`'s
 * own doc comment for why a deterministic, template-based answering
 * approach is the honest choice here, not a placeholder). It can only ever
 * retrieve and summarize this merchant's own data through the same
 * authorized query services every other page already uses - it cannot
 * execute a payment, change a decision, or see another merchant's data.
 */
export default async function AssistantPage() {
  await requireAuthContext();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="AI Assistant"
        description="Ask about risk, decisions, payments, outcomes, or experiments - answers are grounded in your merchant's real data, never invented."
        icon={AssistantIcon}
      />
      <div className="border-border bg-warning/[0.04] rounded-lg border p-3 text-xs">
        <span className="text-fg font-medium">Read-only and non-authoritative.</span>{" "}
        <span className="text-fg-secondary">
          This assistant summarizes existing records - it never executes a payment, changes a decision, or overrides the Decision
          Engine. It does not use a generative language model; every answer is composed from your merchant&apos;s own data by
          fixed, deterministic logic, so it can never invent a figure it doesn&apos;t have.
        </span>
      </div>
      <AssistantPanel />
    </div>
  );
}
