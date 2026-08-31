"use client";

import { useState, type FormEvent } from "react";
import { SendIcon } from "@/lib/design/icons";
import { Button } from "@/components/ui/Button";

type Exchange = { question: string; answer: string; citations: string[]; error?: boolean };

const EXAMPLE_PROMPTS = [
  "Why is revenue at risk?",
  "Which cases need attention?",
  "What recovery outcomes did we get?",
  "What does the experiment show?",
];

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
        setExchanges((prev) => [...prev, { question: trimmed, answer: data.answer, citations: data.citations ?? [] }]);
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
