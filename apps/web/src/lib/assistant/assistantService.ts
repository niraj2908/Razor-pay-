import type { RecoveryDecision } from "@prisma/client";
import { getRecoveryOverview, getDecisionMix, getRecoveryOpportunityPaise } from "@/lib/recovery/overviewService";
import { listRecoveryQueue } from "@/lib/recovery/recoveryQueueService";
import { getDecisionDetail, findDecisionIdByPaymentReference } from "@/lib/recovery/decisionDetailService";
import { listExperiments, getExperimentDetail } from "@/lib/experiments/measurement/experimentQueryService";
import { getPaymentActivity } from "@/lib/reports/reportingService";
import { getRecentActivity } from "@/lib/recovery/activityFeedService";
import { formatPaiseAsInr } from "@/lib/design/money";
import { formatPercentOrUnavailable } from "@/lib/design/percent";
import { humanizeEnumValue, humanizeAuditAction } from "@/lib/design/text";

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

/**
 * How the figures inside `answer` must be read. The assistant reports three
 * genuinely different kinds of number and must never let a reader confuse
 * them:
 *
 *   observed        - a fact counted from persisted rows (e.g. "25 of 53
 *                     outcomes recovered"). No inference at all.
 *   estimated       - a model probability from the recovery models, which
 *                     are documented hand-set baselines, NOT trained on real
 *                     outcome data (see docs/decision-engine.md §6). Advisory
 *                     input to the Decision Engine, never a measured fact.
 *   validated_causal- an incremental/counterfactual figure that the
 *                     measurement pipeline independently marked VALID_EFFECT.
 *                     The ONLY kind that may be described causally.
 *   none            - no figures (guidance, clarifying questions, errors).
 */
export type AssistantEvidence = "observed" | "estimated" | "validated_causal" | "none";

export type AssistantAnswer = {
  intent: string;
  answer: string;
  citations: string[];
  evidence: AssistantEvidence;
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
    intent: "risk_summary", evidence: "observed",
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
    return { intent: "attention", evidence: "observed", answer: "No open recovery candidates require attention right now.", citations: ["Recovery Queue - status=open"] };
  }
  const lines = result.items.map(
    (item, i) =>
      `${i + 1}. ${humanizeEnumValue(item.diagnosis)}, ${formatPaiseAsInr(item.amountAtRiskPaise)}${item.decision ? ` - decision: ${humanizeEnumValue(item.decision.decisionType)}` : " - no decision yet"}`
  );
  return {
    intent: "attention", evidence: "observed",
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
      intent: "decisions_by_status", evidence: "observed",
      answer: `No open recovery candidates currently have ${article} ${label} decision.`,
      citations: [`Recovery Queue - status=open, decisionType=${decisionType}`],
    };
  }
  const lines = result.items.map(
    (item, i) => `${i + 1}. ${humanizeEnumValue(item.diagnosis)}, ${formatPaiseAsInr(item.amountAtRiskPaise)}`
  );
  return {
    intent: "decisions_by_status", evidence: "observed",
    answer: `${result.items.length} open candidate${result.items.length === 1 ? "" : "s"} with ${article} ${label} decision (highest amount at risk first):\n${lines.join("\n")}`,
    citations: [`Recovery Queue - status=open, decisionType=${decisionType}, sort=amountAtRisk_desc, limit=${result.items.length}`],
  };
}

async function answerExplainDecision(merchantId: string, decisionId: string): Promise<AssistantAnswer> {
  const result = await getDecisionDetail(merchantId, decisionId);
  if (result.status === "not_found") {
    return { intent: "explain_decision", evidence: "observed", answer: `I can't find a decision matching "${decisionId}" in your merchant's data.`, citations: [] };
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
    intent: "explain_decision", evidence: "observed",
    answer: `Decision ${decisionId}: ${humanizeEnumValue(decision.decisionType)} on a payment with ${humanizeEnumValue(decision.revenueRiskEvent.diagnosis)}, ${formatPaiseAsInr(decision.revenueRiskEvent.amountAtRiskPaise)} at risk.${reasonPart}${actionPart}${outcomePart}`,
    citations: [`Decision ${decisionId} - full detail via Decision Detail`],
  };
}

async function answerPaymentLookup(merchantId: string, reference: string): Promise<AssistantAnswer> {
  const decisionId = await findDecisionIdByPaymentReference(merchantId, reference);
  if (!decisionId) {
    return { intent: "payment_lookup", evidence: "observed", answer: `I can't find a payment matching "${reference}" in your merchant's data.`, citations: [] };
  }
  const explained = await answerExplainDecision(merchantId, decisionId);
  return { ...explained, intent: "payment_lookup", evidence: "observed", answer: `Payment ${reference} led to the following: ${explained.answer}` };
}

async function answerRecoveryOutcomes(merchantId: string): Promise<AssistantAnswer> {
  const overview = await getRecoveryOverview(merchantId, {});
  const a = overview.attributedOutcomes;
  if (a.matureOutcomesCount === 0) {
    return { intent: "recovery_outcomes", evidence: "observed", answer: "No outcomes have matured yet, so there's nothing to report on recovery results.", citations: ["Recovery Overview - attributedOutcomes"] };
  }
  return {
    intent: "recovery_outcomes", evidence: "observed",
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
    return { intent: "experiment", evidence: "observed", answer: "No experiments are configured for this merchant.", citations: [] };
  }
  const result = await getExperimentDetail(merchantId, experimentId);
  if (result.status === "not_found") {
    return { intent: "experiment", evidence: "observed", answer: `I can't find an experiment matching "${experimentId}" in your merchant's data.`, citations: [] };
  }
  const experiment = result.experiment;
  if (!experiment.latestResult) {
    return { intent: "experiment", evidence: "observed", answer: `Experiment "${experiment.name}" has no measurement result yet.`, citations: [`Experiment ${experiment.id}`] };
  }
  const r = experiment.latestResult;
  // Narrow on the DTO directly (not via an extracted boolean) so TypeScript
  // keeps the discriminated-union narrowing that guards the estimate fields.
  const estimate = r.incrementalEstimate;
  const hasValidatedEffect = estimate.status === "available";
  const incremental =
    estimate.status === "available"
      ? ` This has been validated as a statistically confirmed effect: ${formatPaiseAsInr(estimate.estimatedIncrementalGMVPaise)} incremental (causal) recovered GMV.`
      : " This has NOT been validated as a statistically confirmed causal effect, so no incremental figure is reported.";
  return {
    // The raw treatment/control rates are observed, but once the measurement
    // pipeline has independently marked the result VALID_EFFECT this answer
    // also carries a genuine causal figure - label it as such, because
    // "observed" would understate exactly the claim a reader must not blur.
    intent: "experiment",
    evidence: hasValidatedEffect ? "validated_causal" : "observed",
    answer: `Experiment "${experiment.name}" (${humanizeEnumValue(experiment.status)}): treatment recovery rate ${formatPercentOrUnavailable(r.treatment.rate)} vs. control ${formatPercentOrUnavailable(r.control.rate)} - an observed difference, not on its own a causal claim.${incremental}`,
    citations: [`Experiment ${experiment.id} - latest measurement result`],
  };
}

/** Decision-type distribution across currently-open candidates. Reuses the
 * same `getDecisionMix()` the Overview screen renders, so the assistant can
 * never disagree with the dashboard. */
async function answerDecisionMix(merchantId: string): Promise<AssistantAnswer> {
  const mix = await getDecisionMix(merchantId);
  const total = mix.ACT + mix.WAIT + mix.STOP + mix.ESCALATE;
  if (total === 0) {
    return {
      intent: "decision_mix",
      evidence: "observed",
      answer: "No open recovery candidates currently have a decision.",
      citations: ["Recovery Overview - decision mix across open candidates"],
    };
  }
  return {
    intent: "decision_mix",
    evidence: "observed",
    answer: `Across ${total} open recovery ${total === 1 ? "candidate" : "candidates"}, the Decision Engine's most recent call was:\nAct ${mix.ACT}\nWait ${mix.WAIT}\nStop ${mix.STOP}\nEscalate ${mix.ESCALATE}`,
    citations: ["Recovery Overview - decision mix across open candidates (latest decision per candidate)"],
  };
}

/** Payment-level activity, reusing the Reports aggregation verbatim. */
async function answerPaymentActivity(merchantId: string): Promise<AssistantAnswer> {
  const activity = await getPaymentActivity(merchantId, {});
  if (activity.totalCount === 0) {
    return {
      intent: "payment_activity",
      evidence: "observed",
      answer: "No payments are recorded for this merchant yet.",
      citations: ["Reports - payment activity"],
    };
  }
  const byStatus = Object.entries(activity.byStatus)
    .map(([s, v]) => `${humanizeEnumValue(s)}: ${v?.count ?? 0} (${formatPaiseAsInr(v?.amountPaise ?? 0)})`)
    .join("\n");
  const topMethods = activity.byMethod
    .slice(0, 3)
    .map((m) => `${humanizeEnumValue(m.method)} ${m.count}`)
    .join(", ");
  return {
    intent: "payment_activity",
    evidence: "observed",
    answer: `${activity.totalCount} payments totalling ${formatPaiseAsInr(activity.totalAmountPaise)}.\nBy status:\n${byStatus}\nMost common methods: ${topMethods}.`,
    citations: ["Reports - payment activity aggregated by status and method"],
  };
}

/** Intervention execution performance - attempted vs succeeded vs the
 * separately-attributed recovered count. Deliberately states that these are
 * counted on different grains so the three numbers are never misread as a
 * strict per-unit funnel (the same caveat the Overview screen carries). */
async function answerExecutionPerformance(merchantId: string): Promise<AssistantAnswer> {
  const overview = await getRecoveryOverview(merchantId, {});
  const op = overview.operational;
  if (op.interventionsAttempted === 0) {
    return {
      intent: "execution_performance",
      evidence: "observed",
      answer: "No recovery interventions have been attempted in this period.",
      citations: ["Recovery Overview - operational.interventionsAttempted"],
    };
  }
  return {
    intent: "execution_performance",
    evidence: "observed",
    answer: `Interventions attempted: ${op.interventionsAttempted}. Executions that succeeded: ${op.interventionsSucceeded}. Separately, ${overview.attributedOutcomes.interventionRecoveryCount} outcomes were attributed to intervention recovery (${formatPaiseAsInr(overview.attributedOutcomes.interventionRecoveryGmvPaise)}). Note: attempts/successes are counted per execution while recoveries are counted per attributed outcome, so these are not a strict per-unit funnel.`,
    citations: [
      "Recovery Overview - operational.interventionsAttempted, interventionsSucceeded",
      "Recovery Overview - attributedOutcomes.interventionRecoveryCount",
    ],
  };
}

/** Recent decision/execution/outcome activity, reusing the same sanitized
 * audit feed the Overview and Audit screens render. */
async function answerRecentActivity(merchantId: string): Promise<AssistantAnswer> {
  const events = await getRecentActivity(merchantId, 8);
  if (events.length === 0) {
    return {
      intent: "recent_activity",
      evidence: "observed",
      answer: "No decisions, executions or outcomes have been recorded yet.",
      citations: ["Audit trail - recent activity"],
    };
  }
  const lines = events.map((e, i) => `${i + 1}. ${humanizeAuditAction(e.action)} - ${e.createdAt}`);
  return {
    intent: "recent_activity",
    evidence: "observed",
    answer: `The ${events.length} most recent recovery events:\n${lines.join("\n")}`,
    citations: [`Audit trail - ${events.length} most recent sanitized audit events`],
  };
}

/** The recovery opportunity figure is the sum of a MODEL-produced
 * `expectedIncrementalValue`, so it is explicitly labelled an estimate and
 * the answer states the models are untrained baselines - it must never be
 * read as observed revenue or as a causal claim. */
async function answerRecoveryOpportunity(merchantId: string): Promise<AssistantAnswer> {
  const [opportunity, overview] = await Promise.all([
    getRecoveryOpportunityPaise(merchantId),
    getRecoveryOverview(merchantId, {}),
  ]);
  return {
    intent: "recovery_opportunity",
    evidence: "estimated",
    answer: `Estimated recovery opportunity across currently-open decisions: ${formatPaiseAsInr(opportunity)}, against ${formatPaiseAsInr(overview.operational.revenueAtRiskPaise)} of revenue at risk. This is an ESTIMATE: it sums the Decision Engine's expected incremental value per open decision, which is derived from transparent hand-set baseline models (not models trained on real outcome data). It is not observed revenue and not a causal claim.`,
    citations: [
      "Recovery Overview - sum of Decision.expectedIncrementalValue across open decisions",
      "Recovery Overview - operational.revenueAtRiskPaise",
    ],
  };
}

/** Honest self-description. Explicitly states that no external language
 * model is in use, so an evaluator is never left assuming an LLM is running. */
function answerCapabilities(): AssistantAnswer {
  return {
    intent: "capabilities",
    evidence: "none",
    answer:
      'I answer from your merchant\'s real, authorized application data. I am read-only: I cannot execute a payment, change a decision, or override the Decision Engine.\n\nI do not use a generative language model - every answer is composed from your own data by fixed, deterministic logic, so I cannot invent a figure.\n\nI can answer:\n- "Why is revenue at risk?"\n- "What is the recovery opportunity?"\n- "Which cases need attention?"\n- "Which decisions are waiting / escalated / stopped?"\n- "What is the decision mix?"\n- "What payment activity do we have?"\n- "How did interventions perform?"\n- "What recovery outcomes did we get?"\n- "What happened recently?"\n- "What does the experiment show?"\n- "Explain decision <id>"\n- "What happened to payment <id>?"',
    citations: [],
  };
}

const FALLBACK_ANSWER: AssistantAnswer = {
  intent: "fallback", evidence: "none",
  answer:
    'I can answer questions grounded in your merchant\'s real data. Try: "Why is revenue at risk?", "What is the recovery opportunity?", "Which cases need attention?", "Which decisions are waiting?", "What is the decision mix?", "What payment activity do we have?", "How did interventions perform?", "What happened recently?", "What recovery outcomes did we get?", "What does the experiment show?", "Explain decision <id>", or "What happened to payment <id>?" — or ask "what can you do?"',
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
  // Self-description first: "what can you do" must never be answered with data.
  if (/\b(what can you do|capabilities|help me|how can you help|what do you do)\b/.test(q)) {
    return answerCapabilities();
  }
  // "recovery opportunity" is checked before the generic risk/recovery rules,
  // because it is the one figure that is an ESTIMATE rather than observed.
  if (/\b(opportunity|expected incremental|potential recovery)\b/.test(q)) {
    return answerRecoveryOpportunity(merchantId);
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
  // Distribution questions carry no status keyword, so they fall through the
  // status matcher above and land here.
  if (/\b(mix|distribution|breakdown|how many decisions|split)\b/.test(q) && /\b(decision|decisions)\b/.test(q)) {
    return answerDecisionMix(merchantId);
  }
  if (/\b(execution|executions|intervention|interventions)\b/.test(q)) {
    return answerExecutionPerformance(merchantId);
  }
  if (/\b(recent|recently|latest|last few|activity|happened)\b/.test(q) && !/payment/.test(q)) {
    return answerRecentActivity(merchantId);
  }
  if (/explain/.test(q) && /decision/.test(q)) {
    return { intent: "explain_decision", evidence: "none", answer: "Which decision? Include its id, e.g. \"Explain decision cljk3n9p1...\".", citations: [] };
  }
  // Aggregate payment questions before the "which payment id?" prompt.
  if (/\bpayments\b|payment activity|payment volume|payment method/.test(q)) {
    return answerPaymentActivity(merchantId);
  }
  if (/payment/.test(q)) {
    return { intent: "payment_lookup", evidence: "none", answer: "Which payment? Include its id or Razorpay payment id, e.g. \"What happened to payment pay_ABC123?\".", citations: [] };
  }
  if (/recover(ed|y)|outcome/.test(q)) {
    return answerRecoveryOutcomes(merchantId);
  }
  if (/experiment/.test(q)) {
    return answerExperiment(merchantId, null);
  }

  return FALLBACK_ANSWER;
}
