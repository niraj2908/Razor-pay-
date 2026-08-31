import type { RecoveryDecision } from "@prisma/client";
import { getRecoveryOverview } from "@/lib/recovery/overviewService";
import { listRecoveryQueue } from "@/lib/recovery/recoveryQueueService";
import { getDecisionDetail, findDecisionIdByPaymentReference } from "@/lib/recovery/decisionDetailService";
import { listExperiments, getExperimentDetail } from "@/lib/experiments/measurement/experimentQueryService";
import { formatPaiseAsInr } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue } from "@/lib/design/text";

/**
 * The AI Operational Assistant's answering logic (Phase 28C).
 *
 * This is deliberately NOT a call to a generative language model - no
 * ANTHROPIC_API_KEY/OPENAI_API_KEY or equivalent exists anywhere in this
 * deployment's configuration, and the product requirement (READ-ONLY,
 * GROUNDED, EVIDENCE-BASED, NON-AUTHORITATIVE) is one a small, fixed set of
 * deterministic intents can satisfy honestly, without ever risking a
 * fabricated number: every sentence this module returns is built by
 * substituting real values from an already-authorized query service into a
 * fixed template - there is no generation step that could invent a
 * payment, a metric, or a decision that doesn't exist.
 *
 * Every intent takes `merchantId` from the caller (the route handler,
 * which resolves it the same way every other route does -
 * authenticateOperator -> resolveMerchantAccess) and passes it straight
 * into the same query services every page already uses. This module holds
 * no database client of its own and enforces no isolation itself - it
 * inherits the isolation already proven at the query-service layer.
 */

export type AssistantAnswer = {
  intent: string;
  answer: string;
  citations: string[];
};

const ID_PATTERN = /\b[a-z0-9]{10,40}\b/gi;

/** A real cuid/id always contains a digit; an ordinary English word of the
 * same rough length (e.g. "attention") typically does not - cheap, honest
 * filter against treating a stray word as an id, never a security boundary
 * (the query services themselves fail closed on a non-matching id). */
function extractIdCandidates(question: string): string[] {
  return (question.match(ID_PATTERN) ?? []).filter((token) => /[0-9]/.test(token));
}

async function answerRiskSummary(merchantId: string): Promise<AssistantAnswer> {
  const [overview, topCandidates] = await Promise.all([
    getRecoveryOverview(merchantId, {}),
    listRecoveryQueue(merchantId, { status: "open", sort: "amountAtRisk_desc", limit: 5 }),
  ]);

  const diagnoses = new Map<string, number>();
  for (const item of topCandidates.items) {
    diagnoses.set(item.diagnosis, (diagnoses.get(item.diagnosis) ?? 0) + 1);
  }
  const diagnosisSummary =
    diagnoses.size > 0
      ? Array.from(diagnoses.entries()).map(([d, c]) => `${humanizeEnumValue(d)} (${c})`).join(", ")
      : "no open candidates";

  return {
    intent: "risk_summary",
    answer: `Revenue at risk right now: ${formatPaiseAsInr(overview.operational.revenueAtRiskPaise)}, across ${overview.operational.candidatesCount} open recovery ${overview.operational.candidatesCount === 1 ? "candidate" : "candidates"}. Among the highest-value open candidates, the leading diagnoses are: ${diagnosisSummary}.`,
    citations: [
      `Recovery Overview - operational.revenueAtRiskPaise, operational.candidatesCount`,
      `Recovery Queue - top ${topCandidates.items.length} open candidates by amount at risk`,
    ],
  };
}

async function answerAttention(merchantId: string): Promise<AssistantAnswer> {
  const result = await listRecoveryQueue(merchantId, { status: "open", sort: "amountAtRisk_desc", limit: 5 });
  if (result.items.length === 0) {
    return { intent: "attention", answer: "No open recovery candidates require attention right now.", citations: ["Recovery Queue - status=open"] };
  }
  const lines = result.items.map(
    (item, i) =>
      `${i + 1}. ${humanizeEnumValue(item.diagnosis)}, ${formatPaiseAsInr(item.amountAtRiskPaise)}${item.decision ? ` - decision: ${humanizeEnumValue(item.decision.decisionType)}` : " - no decision yet"}`
  );
  return {
    intent: "attention",
    answer: `The ${result.items.length} highest-value open candidates right now:\n${lines.join("\n")}`,
    citations: [`Recovery Queue - status=open, sort=amountAtRisk_desc, limit=${result.items.length}`],
  };
}

/** A question naming a decision status ("which decisions are waiting?",
 * "what's been escalated?") must be answered from THAT status specifically,
 * not swallowed by the broader recovery-outcomes intent just because the
 * word "recovery" or "decisions" also appears - this was the exact gap
 * found during local verification ("Which recovery decisions are
 * waiting?" incorrectly answered the general outcomes question instead).
 * Reuses `listRecoveryQueue`'s existing `decisionType` filter - a real,
 * already-authorized capability, not a new query. */
const DECISION_STATUS_KEYWORDS: Record<RecoveryDecision, RegExp> = {
  ACT: /\bact(ing|ed|ion)?\b/,
  WAIT: /\bwait(ing|ed)?\b/,
  STOP: /\bstop(ped|ping)?\b/,
  ESCALATE: /\bescalat(e|ed|ing|ion)\b/,
};

function detectDecisionStatusIntent(q: string): RecoveryDecision | null {
  if (!/\b(decision|decisions|case|cases|candidate|candidates)\b/.test(q)) return null;
  for (const [type, pattern] of Object.entries(DECISION_STATUS_KEYWORDS) as Array<[RecoveryDecision, RegExp]>) {
    if (pattern.test(q)) return type;
  }
  return null;
}

async function answerDecisionsByStatus(merchantId: string, decisionType: RecoveryDecision): Promise<AssistantAnswer> {
  const result = await listRecoveryQueue(merchantId, { status: "open", decisionType, sort: "amountAtRisk_desc", limit: 5 });
  const label = humanizeEnumValue(decisionType);
  const article = /^[AEIOU]/.test(label) ? "an" : "a";
  if (result.items.length === 0) {
    return {
      intent: "decisions_by_status",
      answer: `No open recovery candidates currently have ${article} ${label} decision.`,
      citations: [`Recovery Queue - status=open, decisionType=${decisionType}`],
    };
  }
  const lines = result.items.map(
    (item, i) => `${i + 1}. ${humanizeEnumValue(item.diagnosis)}, ${formatPaiseAsInr(item.amountAtRiskPaise)}`
  );
  return {
    intent: "decisions_by_status",
    answer: `${result.items.length} open candidate${result.items.length === 1 ? "" : "s"} with ${article} ${label} decision (highest amount at risk first):\n${lines.join("\n")}`,
    citations: [`Recovery Queue - status=open, decisionType=${decisionType}, sort=amountAtRisk_desc, limit=${result.items.length}`],
  };
}

async function answerExplainDecision(merchantId: string, decisionId: string): Promise<AssistantAnswer> {
  const result = await getDecisionDetail(merchantId, decisionId);
  if (result.status === "not_found") {
    return { intent: "explain_decision", answer: `I can't find a decision matching "${decisionId}" in your merchant's data.`, citations: [] };
  }
  const decision = result.decision;
  const reasonPart = decision.decisionContext?.reason ? ` Recorded reason: ${humanizeEnumValue(decision.decisionContext.reason)}.` : "";
  const actionPart = decision.chosenAction
    ? ` Chosen action: ${humanizeEnumValue(decision.chosenAction.actionType)}, predicted success probability ${formatPercentOrUnavailable(decision.chosenAction.predictedSuccessProbability)}.`
    : "";
  const outcomePart = decision.outcome
    ? ` Outcome: ${humanizeEnumValue(decision.outcome.status)}${decision.outcome.recoveredAmountPaise !== null ? `, recovered ${formatPaiseAsInr(decision.outcome.recoveredAmountPaise)}` : ""}.`
    : " No outcome recorded yet.";

  return {
    intent: "explain_decision",
    answer: `Decision ${decisionId}: ${humanizeEnumValue(decision.decisionType)} on a payment with ${humanizeEnumValue(decision.revenueRiskEvent.diagnosis)}, ${formatPaiseAsInr(decision.revenueRiskEvent.amountAtRiskPaise)} at risk.${reasonPart}${actionPart}${outcomePart}`,
    citations: [`Decision ${decisionId} - full detail via Decision Detail`],
  };
}

async function answerPaymentLookup(merchantId: string, reference: string): Promise<AssistantAnswer> {
  const decisionId = await findDecisionIdByPaymentReference(merchantId, reference);
  if (!decisionId) {
    return { intent: "payment_lookup", answer: `I can't find a payment matching "${reference}" in your merchant's data.`, citations: [] };
  }
  const explained = await answerExplainDecision(merchantId, decisionId);
  return { ...explained, intent: "payment_lookup", answer: `Payment ${reference} led to the following: ${explained.answer}` };
}

async function answerRecoveryOutcomes(merchantId: string): Promise<AssistantAnswer> {
  const overview = await getRecoveryOverview(merchantId, {});
  const a = overview.attributedOutcomes;
  if (a.matureOutcomesCount === 0) {
    return { intent: "recovery_outcomes", answer: "No outcomes have matured yet, so there's nothing to report on recovery results.", citations: ["Recovery Overview - attributedOutcomes"] };
  }
  return {
    intent: "recovery_outcomes",
    answer: `${a.recoveredCount} of ${a.matureOutcomesCount} mature outcomes recovered (${formatPercentOrUnavailable(a.observedRecoveryRate)}). Natural recovery: ${formatPaiseAsInr(a.naturalRecoveryGmvPaise)} across ${a.naturalRecoveryCount} outcomes. Intervention recovery: ${formatPaiseAsInr(a.interventionRecoveryGmvPaise)} across ${a.interventionRecoveryCount} outcomes.`,
    citations: ["Recovery Overview - attributedOutcomes"],
  };
}

async function answerExperiment(merchantId: string, explicitId: string | null): Promise<AssistantAnswer> {
  let experimentId = explicitId;
  if (!experimentId) {
    const list = await listExperiments(merchantId, { limit: 1 });
    experimentId = list.items[0]?.id ?? null;
  }
  if (!experimentId) {
    return { intent: "experiment", answer: "No experiments are configured for this merchant.", citations: [] };
  }
  const result = await getExperimentDetail(merchantId, experimentId);
  if (result.status === "not_found") {
    return { intent: "experiment", answer: `I can't find an experiment matching "${experimentId}" in your merchant's data.`, citations: [] };
  }
  const experiment = result.experiment;
  if (!experiment.latestResult) {
    return { intent: "experiment", answer: `Experiment "${experiment.name}" has no measurement result yet.`, citations: [`Experiment ${experiment.id}`] };
  }
  const r = experiment.latestResult;
  const incremental =
    r.incrementalEstimate.status === "available"
      ? ` This has been validated as a statistically confirmed effect: ${formatPaiseAsInr(r.incrementalEstimate.estimatedIncrementalGMVPaise)} incremental (causal) recovered GMV.`
      : " This has NOT been validated as a statistically confirmed causal effect, so no incremental figure is reported.";
  return {
    intent: "experiment",
    answer: `Experiment "${experiment.name}" (${humanizeEnumValue(experiment.status)}): treatment recovery rate ${formatPercentOrUnavailable(r.treatment.rate)} vs. control ${formatPercentOrUnavailable(r.control.rate)} - an observed difference, not on its own a causal claim.${incremental}`,
    citations: [`Experiment ${experiment.id} - latest measurement result`],
  };
}

const FALLBACK_ANSWER: AssistantAnswer = {
  intent: "fallback",
  answer:
    'I can answer questions grounded in your merchant\'s real data. Try: "Why is revenue at risk?", "Which cases need attention?", "Which decisions are waiting?", "Explain decision <id>", "What happened to payment <id>?", "What recovery outcomes did we get?", or "What does the experiment show?"',
  citations: [],
};

/**
 * Classifies `question` into one of the supported intents and answers it.
 * Order matters: an explicit id + "payment"/"decision" wording is checked
 * before the generic keyword intents, so a specific, answerable question
 * is never swallowed by a broader fallback.
 */
export async function answerAssistantQuestion(merchantId: string, question: string): Promise<AssistantAnswer> {
  const q = question.toLowerCase();
  const idCandidates = extractIdCandidates(question);

  if (idCandidates.length > 0 && /payment/.test(q)) {
    return answerPaymentLookup(merchantId, idCandidates[0]);
  }
  if (idCandidates.length > 0 && /decision/.test(q)) {
    return answerExplainDecision(merchantId, idCandidates[0]);
  }
  if (idCandidates.length > 0 && /experiment/.test(q)) {
    return answerExperiment(merchantId, idCandidates[0]);
  }
  if (/(why|reason).*(at risk|risk)|revenue at risk/.test(q)) {
    return answerRiskSummary(merchantId);
  }
  if (/attention|which case|need(s)? (attention|review)/.test(q)) {
    return answerAttention(merchantId);
  }
  const decisionStatus = detectDecisionStatusIntent(q);
  if (decisionStatus) {
    return answerDecisionsByStatus(merchantId, decisionStatus);
  }
  if (/explain/.test(q) && /decision/.test(q)) {
    return { intent: "explain_decision", answer: "Which decision? Include its id, e.g. \"Explain decision cljk3n9p1...\".", citations: [] };
  }
  if (/payment/.test(q)) {
    return { intent: "payment_lookup", answer: "Which payment? Include its id or Razorpay payment id, e.g. \"What happened to payment pay_ABC123?\".", citations: [] };
  }
  if (/recover(ed|y)|outcome/.test(q)) {
    return answerRecoveryOutcomes(merchantId);
  }
  if (/experiment/.test(q)) {
    return answerExperiment(merchantId, null);
  }

  return FALLBACK_ANSWER;
}
