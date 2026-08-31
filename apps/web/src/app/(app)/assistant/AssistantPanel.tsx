"use client";

import { useState, type FormEvent } from "react";
import { SendIcon } from "@/lib/design/icons";
import { Button } from "@/components/ui/Button";

type Evidence = "observed" | "estimated" | "validated_causal" | "none";

type Exchange = {
  question: string;
  answer: string;
  citations: string[];
  evidence?: Evidence;
  error?: boolean;
};

const EXAMPLE_PROMPTS = [
  "Why is revenue at risk?",
  "What is the recovery opportunity?",
  "Which decisions are waiting?",
  "How did interventions perform?",
  "What does the experiment show?",
  "What can you do?",
];

/**
 * Renders HOW a figure should be read, never hidden behind a toggle. An
 * operator must be able to tell at a glance whether a number was counted
 * from real rows, produced by an untrained baseline model, or independently
 * validated as a causal effect - these are three very different claims and
 * conflating them is the main way a recovery dashboard misleads someone.
 */
const EVIDENCE_LABEL: Record<Exclude<Evidence, "none">, { text: string; className: string }> = {
  observed: {
    text: "Observed",
    className: "border-success/30 bg-success/10 text-success",
  },
  estimated: {
    text: "Estimated · model",
    className: "border-warning/30 bg-warning/10 text-warning",
  },
  validated_causal: {
    text: "Validated causal effect",
    className: "border-info/30 bg-info/10 text-info",
  },
};

/**
 * The AI Operational Assistant's chat surface (Phase 28C). Talks to
 * POST /api/assistant/query only - every answer it renders came back from
 * that route's own deterministic, grounded logic (`assistantService.ts`),
 * never generated client-side. Citations are always shown alongside an
 * answer, never hidden behind a "sources" toggle, so the non-authoritative
 * nature of every response stays visible by default.
 */
export function AssistantPanel() {
  const [question, setQuestion] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [pending, setPending] = useState(false);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setPending(true);
    setQuestion("");
    try {
      const response = await fetch("/api/assistant/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      if (response.status === 200) {
        const data = await response.json();
        setExchanges((prev) => [
          ...prev,
          { question: trimmed, answer: data.answer, citations: data.citations ?? [], evidence: data.evidence },
        ]);
      } else if (response.status === 429) {
        setExchanges((prev) => [...prev, { question: trimmed, answer: "Too many questions in a short time. Please wait a moment and try again.", citations: [], error: true }]);
      } else {
        setExchanges((prev) => [...prev, { question: trimmed, answer: "Something went wrong answering that. Try again.", citations: [], error: true }]);
      }
    } catch {
      setExchanges((prev) => [...prev, { question: trimmed, answer: "Could not reach the server. Check your connection and try again.", citations: [], error: true }]);
    } finally {
      setPending(false);
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    ask(question);
  }

  return (
    <div className="flex flex-col gap-4">
      {exchanges.length === 0 ? (
        <div className="flex flex-wrap gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => ask(prompt)}
              className="border-border bg-surface text-fg-secondary hover:bg-surface-subtle hover:text-fg rounded-full border px-3 py-1.5 text-sm"
            >
              {prompt}
            </button>
          ))}
        </div>
      ) : (
        <ol aria-live="polite" className="flex flex-col gap-4">
          {exchanges.map((exchange, i) => (
            <li key={i} className="flex flex-col gap-2">
              <div className="text-fg self-end rounded-lg bg-surface-subtle px-3 py-2 text-sm">{exchange.question}</div>
              <div className={`border-border rounded-lg border p-3 text-sm whitespace-pre-line ${exchange.error ? "text-danger" : "text-fg-secondary"}`}>
                {exchange.evidence && exchange.evidence !== "none" && !exchange.error ? (
                  <div className="mb-2">
                    <span
                      className={`inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase ${EVIDENCE_LABEL[exchange.evidence].className}`}
                    >
                      {EVIDENCE_LABEL[exchange.evidence].text}
                    </span>
                  </div>
                ) : null}
                {exchange.answer}
                {exchange.citations.length > 0 ? (
                  <div className="border-border text-fg-muted mt-2 border-t pt-2 text-xs">
                    Grounded in: {exchange.citations.join("; ")}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}

      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="assistant-question" className="text-fg-secondary text-sm font-medium">
            Ask a question
          </label>
          <input
            id="assistant-question"
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="e.g. Why is revenue at risk?"
            disabled={pending}
            className="border-border bg-surface text-fg focus-visible:border-info h-10 rounded-md border px-3 text-sm disabled:opacity-50"
          />
        </div>
        <Button type="submit" loading={pending} disabled={question.trim().length === 0}>
          <SendIcon aria-hidden="true" className="h-4 w-4" />
          Ask
        </Button>
      </form>
    </div>
  );
}
