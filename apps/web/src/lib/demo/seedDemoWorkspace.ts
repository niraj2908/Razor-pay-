import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { evaluateRecoveryDecision } from "@/lib/recovery/decisionEngine";
import type { RecoveryContext } from "@/lib/recovery/types";
import { processOutcomeAttributionForPaymentEvent } from "@/lib/outcomes/outcomeService";
import { resolveExperimentAssignment } from "@/lib/experiments/experimentService";
import { computeExperimentResult } from "@/lib/experiments/measurement/experimentResultService";
import { persistExperimentResult } from "@/lib/experiments/measurement/experimentMeasurementResultService";
import { resolveDemoConfig, DEMO_IDENTITY, type DemoConfigResolution, type DemoWorkspaceIdentity } from "./config";
import { DEMO_DECISION_SCENARIOS, buildScenarioContext } from "./scenarios";
import { persistDemoDecision, persistSyntheticExecution } from "./persistence";

/**
 * Demo/Evaluation Workspace seed (Phase 28B).
 *
 * Builds a complete, realistic Risk -> Decision -> Action -> Result ->
 * Experiment -> Evidence -> Audit dataset for exactly one dedicated,
 * clearly-labeled synthetic Merchant - never touching any other Merchant,
 * never modifying normal signup, never calling a real Razorpay API (see
 * this module's own notes on why Execution rows are created directly
 * rather than through `executionService.executeCommand`).
 *
 * What is REAL, not fabricated, in this dataset:
 *   - Every Decision comes from the real, unmodified `evaluateRecoveryDecision()`.
 *   - Every Outcome comes from the real, unmodified
 *     `outcomeService.processOutcomeAttributionForPaymentEvent()`, which
 *     itself calls the real, unmodified attribution engine.
 *   - Every experiment assignment comes from the real, unmodified
 *     `resolveExperimentAssignment()` (SHA-256 deterministic hashing).
 *   - The experiment's statistical result comes from the real, unmodified
 *     `computeExperimentResult()` / `persistExperimentResult()` pipeline -
 *     whatever `resultStatus` that pipeline honestly produces is what gets
 *     persisted, never adjusted after the fact.
 *
 * What is DECIDED here (unavoidably, since this is synthetic data): the
 * ground truth of what "happened" to each synthetic payment (whether a
 * payment link got paid, whether a payment recovered naturally) - the
 * INPUT to the real engines above, never their output.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;
const CONFIDENCE_LEVEL = 0.95;
/** An explicit, disclosed business threshold for this demo experiment: a
 * recovery-rate improvement smaller than 15 percentage points is not
 * considered practically meaningful even if statistically detectable - see
 * resultStatus.ts's own "never invent a threshold" requirement. This value
 * is a deliberate seed-script choice, not a system default. */
const MINIMUM_PRACTICAL_EFFECT_RATE_DIFFERENCE = 0.15;
const MINIMUM_ANALYZABLE_SAMPLE_PER_ARM = 5;
const EXPERIMENT_CANDIDATE_COUNT = 50;

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * ONE_DAY_MS);
}

function minutesAfter(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * ONE_MINUTE_MS);
}

export type SeedDemoWorkspaceResult =
  | { status: "unsafe"; reason: string }
  | { status: "already_seeded"; merchantId: string; operatorId: string }
  | {
      status: "seeded";
      merchantId: string;
      operatorId: string;
      operatorEmail: string;
      decisionScenarios: number;
      experimentId: string;
      experimentCandidates: number;
      experimentTreatmentUnits: number;
      experimentControlUnits: number;
      experimentMeasurementResultStatus: string;
    };

function demoPaymentId(prefix: string, key: string): string {
  return `${prefix}_payment_${key}`;
}
function demoRiskEventId(prefix: string, key: string): string {
  return `${prefix}_risk_${key}`;
}

/**
 * The tag used inside the synthetic, Razorpay-SHAPED reference ids
 * (`plink_DEMO_S0`, `pay_DEMO_E001`). Both columns are uniquely constrained,
 * so they must vary with the workspace identity or a second seeded workspace
 * collides with the first.
 *
 * Uppercasing the prefix means the real Demo Workspace keeps byte-identical
 * ids to before this became a parameter ("demo" -> "DEMO"), so nothing about
 * the evaluator's dataset changed; only a differently-prefixed workspace
 * (the integration suite's) gets different ones.
 */
function refTag(prefix: string): string {
  return prefix.toUpperCase();
}

async function ensureMerchantAndOperator(config: Extract<DemoConfigResolution, { status: "ready" }>) {
  await prisma.merchant.upsert({
    where: { id: config.merchantId },
    update: {},
    create: { id: config.merchantId, name: config.merchantName },
  });

  const existingOperator = await prisma.operator.findUnique({ where: { id: config.operatorId } });
  if (!existingOperator) {
    const passwordHash = await hashPassword(config.operatorPassword);
    await prisma.operator.create({
      data: {
        id: config.operatorId,
        merchantId: config.merchantId,
        email: config.operatorEmail,
        passwordHash,
      },
    });
  }
}

/** Persists the nine hand-designed decision-coverage scenarios (see
 * scenarios.ts) - every ACT/WAIT/STOP/ESCALATE reason the real engine can
 * legitimately produce under the current default policy and model tables. */
async function seedDecisionScenarios(merchantId: string, idPrefix: string, now: Date): Promise<void> {
  for (let i = 0; i < DEMO_DECISION_SCENARIOS.length; i++) {
    const scenario = DEMO_DECISION_SCENARIOS[i];
    console.log(`[demo] decision scenario ${i + 1}/${DEMO_DECISION_SCENARIOS.length}: ${scenario.key}`);
    const paymentId = demoPaymentId(idPrefix, scenario.key);
    const riskEventId = demoRiskEventId(idPrefix, scenario.key);
    const detectedAt = daysAgo(now, 12 - i);
    const decidedAt = minutesAfter(detectedAt, 3);

    await prisma.payment.create({
      data: {
        id: paymentId,
        merchantId,
        amount: scenario.amountPaise,
        method: scenario.paymentMethod,
        status: "FAILED",
        createdAt: detectedAt,
      },
    });

    const context: RecoveryContext = buildScenarioContext(scenario, paymentId, merchantId);
    const trace = evaluateRecoveryDecision(context);

    const persisted = await persistDemoDecision({
      revenueRiskEventId: riskEventId,
      merchantId,
      paymentId,
      amountAtRiskPaise: scenario.amountPaise,
      diagnosis: scenario.diagnosis,
      trace,
      detectedAt,
      decidedAt,
      experimentAssignmentId: null,
    });

    if (scenario.key === "act_retry_network") {
      // No Razorpay-supported execution exists for RETRY (see
      // executionService.ts - only PAYMENT_LINK/CAPTURE are executable).
      // This payment resolves ON ITS OWN, unrelated to our decision -
      // demonstrating NATURAL_RECOVERY attribution, distinct from an
      // intervention actually causing recovery.
      const recoveredAt = minutesAfter(decidedAt, 90);
      await prisma.payment.update({ where: { id: paymentId }, data: { status: "CAPTURED", updatedAt: recoveredAt } });
      const event = await prisma.paymentEvent.create({
        data: {
          paymentId,
          razorpayEventId: `${idPrefix}_event_${scenario.key}_captured`,
          eventType: "payment.captured",
          payload: { event: "payment.captured", demo: true },
          receivedAt: recoveredAt,
        },
      });
      await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
    }

    if (scenario.key === "act_payment_link_abandonment") {
      // A real, successful PAYMENT_LINK execution whose link the customer
      // actually pays - INTERVENTION_RECOVERY.
      const executedAt = minutesAfter(decidedAt, 1);
      const { executionId } = await persistSyntheticExecution({
        decisionId: persisted.decisionId,
        paymentId,
        strategy: "PAYMENT_LINK",
        status: "SUCCEEDED",
        // Short and obviously-synthetic - matching the length real Razorpay
        // identifiers actually have (~15-22 chars) so it never overflows
        // the existing, unmodified Decision Detail layout (see the Phase
        // 28B report: the full scenario key alone overlapped the adjacent
        // "Executed" timestamp at real screen widths).
        razorpayReferenceId: `plink_${refTag(idPrefix)}_S${i}`,
        executedAt,
        completedAt: minutesAfter(executedAt, 1),
      });
      const paidAt = minutesAfter(executedAt, 45);
      const recoveredPayment = await prisma.payment.create({
        data: {
          id: `${idPrefix}_payment_recovered_${scenario.key}`,
          merchantId,
          amount: scenario.amountPaise,
          method: scenario.paymentMethod,
          status: "CAPTURED",
          razorpayPaymentId: `pay_${refTag(idPrefix)}_S${i}`,
          createdAt: paidAt,
        },
      });
      await prisma.execution.update({
        where: { id: executionId },
        data: { recoveredPaymentId: recoveredPayment.id },
      });
      const event = await prisma.paymentEvent.create({
        data: {
          paymentId: recoveredPayment.id,
          razorpayEventId: `${idPrefix}_event_${scenario.key}_link_paid`,
          eventType: "payment_link.paid",
          payload: { event: "payment_link.paid", demo: true },
          receivedAt: paidAt,
        },
      });
      await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
    }

    if (scenario.key === "act_payment_link_other_recoverable") {
      // A real PAYMENT_LINK execution whose creation itself failed at the
      // API level - the attribution window has since closed with no
      // recovery: a legitimate NOT_RECOVERED example.
      const executedAt = minutesAfter(decidedAt, 1);
      await persistSyntheticExecution({
        decisionId: persisted.decisionId,
        paymentId,
        strategy: "PAYMENT_LINK",
        status: "FAILED",
        razorpayReferenceId: null,
        executedAt,
        completedAt: minutesAfter(executedAt, 1),
      });
      // A late/redelivered webhook re-confirming the original payment's
      // failure - a completely ordinary real-world occurrence, and the
      // only way this decision is ever re-evaluated (see this module's
      // report for why the demo cannot rely on a scheduled sweep, since
      // none exists in this codebase today).
      const event = await prisma.paymentEvent.create({
        data: {
          paymentId,
          razorpayEventId: `${idPrefix}_event_${scenario.key}_redelivered_failed`,
          eventType: "payment.failed",
          payload: { event: "payment.failed", demo: true },
          receivedAt: minutesAfter(executedAt, 5),
        },
      });
      await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
    }
  }
}

type ExperimentUnitPlan = { index: number; amountPaise: number; paymentMethod: "card" | "upi" | "netbanking" | "wallet" };

function planExperimentUnits(candidateCount: number): ExperimentUnitPlan[] {
  const methods: ExperimentUnitPlan["paymentMethod"][] = ["card", "upi", "netbanking", "wallet"];
  const plans: ExperimentUnitPlan[] = [];
  for (let i = 0; i < candidateCount; i++) {
    plans.push({
      index: i,
      amountPaise: 20_000 + ((i * 5_309) % 280_000),
      paymentMethod: methods[i % methods.length],
    });
  }
  return plans;
}

/**
 * Seeds the demo experiment: "does sending a Payment Link to
 * checkout-abandonment candidates recover more revenue than doing
 * nothing." Every assignment is real (SHA-256 hash-based, via
 * `resolveExperimentAssignment`), every Decision is real (the same
 * `evaluateRecoveryDecision()` used above), and CONTROL candidates never
 * receive an Execution - the same unconditional rule
 * `candidateBuilder.ts`/`isExecutionAllowed` enforce in production.
 *
 * The only thing this function decides is the synthetic GROUND TRUTH of
 * what happened to each unit (paid vs. never paid; naturally captured vs.
 * not) - designed as a genuine ~60-point true difference (80% success
 * under TREATMENT's intervention vs. 20% natural recovery under CONTROL)
 * so the real statistics/validity pipeline has an honest chance of finding
 * a clear effect; whether it actually does is reported, not forced.
 */
async function seedExperiment(
  merchantId: string,
  experimentId: string,
  idPrefix: string,
  now: Date,
  candidateCount: number
): Promise<{ candidates: number; treatmentUnits: number; controlUnits: number }> {
  const windowStart = daysAgo(now, 21);
  const windowEnd = daysAgo(now, 5);

  await prisma.experiment.create({
    data: {
      id: experimentId,
      merchantId,
      name: "Payment Link Nudge — Checkout Abandonment",
      version: "v1",
      hypothesis:
        "Sending a Razorpay Payment Link to customers whose payment failed due to checkout abandonment recovers more revenue than taking no action.",
      description:
        "Demo/Evaluation experiment (synthetic Test Mode data) - see AuditEvent history for every assignment and outcome.",
      status: "RUNNING",
      trafficAllocationPercent: 100,
      treatmentAllocationPercent: 50,
      treatmentDefinition: "Send a Razorpay Payment Link within the recovery window",
      controlDefinition: "no_intervention",
      startedAt: windowStart,
    },
  });

  const plans = planExperimentUnits(candidateCount);
  let treatmentUnits = 0;
  let controlUnits = 0;

  for (const plan of plans) {
    if (plan.index % 10 === 0) {
      console.log(`[demo] experiment candidate ${plan.index}/${plans.length}`);
    }
    const key = `${idPrefix}_exp_candidate_${String(plan.index).padStart(3, "0")}`;
    const paymentId = demoPaymentId(idPrefix, key);
    const riskEventId = demoRiskEventId(idPrefix, key);
    const fraction = plans.length > 1 ? plan.index / (plans.length - 1) : 0;
    const candidateAt = new Date(windowStart.getTime() + fraction * (windowEnd.getTime() - windowStart.getTime()));
    const decidedAt = minutesAfter(candidateAt, 2);

    await prisma.payment.create({
      data: {
        id: paymentId,
        merchantId,
        amount: plan.amountPaise,
        method: plan.paymentMethod,
        status: "FAILED",
        createdAt: candidateAt,
      },
    });

    const resolution = await resolveExperimentAssignment(
      { customerId: null, candidateKey: riskEventId, paymentState: "failed", merchantId },
      candidateAt
    );
    if (resolution.outcome !== "assigned") {
      throw new Error(`seedExperiment: candidate ${key} did not receive an assignment (${resolution.outcome})`);
    }
    const { arm, id: assignmentId } = resolution.assignment;

    const context: RecoveryContext = {
      paymentId,
      merchantId,
      amount: plan.amountPaise,
      paymentMethod: plan.paymentMethod,
      paymentState: "failed",
      failureReason: "CUSTOMER_ABANDONMENT",
      retryCount: 0,
      minutesSinceLastAttempt: 120,
      customerContactCount: 0,
      hasPendingExecution: false,
      activeIncident: false,
    };
    const trace = evaluateRecoveryDecision(context);

    const persisted = await persistDemoDecision({
      revenueRiskEventId: riskEventId,
      merchantId,
      paymentId,
      amountAtRiskPaise: plan.amountPaise,
      diagnosis: "CUSTOMER_ABANDONMENT",
      trace,
      detectedAt: candidateAt,
      decidedAt,
      experimentAssignmentId: assignmentId,
    });

    if (arm === "TREATMENT") {
      treatmentUnits++;
      // 80% of TREATMENT units convert (paid the link); the remaining 20%
      // receive a real link that is never paid - both are genuine,
      // legitimate PAYMENT_LINK outcomes, not every intervention succeeds.
      const converts = treatmentUnits % 5 !== 0;
      const executedAt = minutesAfter(decidedAt, 1);
      const { executionId } = await persistSyntheticExecution({
        decisionId: persisted.decisionId,
        paymentId,
        strategy: "PAYMENT_LINK",
        status: "SUCCEEDED",
        // Short and obviously-synthetic (see the same note in
        // seedDecisionScenarios) - fits the existing, unmodified Decision
        // Detail layout without overflowing into the adjacent timestamp.
        razorpayReferenceId: `plink_${refTag(idPrefix)}_E${String(plan.index).padStart(3, "0")}`,
        executedAt,
        completedAt: minutesAfter(executedAt, 1),
      });

      if (converts) {
        const paidAt = minutesAfter(executedAt, 60);
        const recoveredPayment = await prisma.payment.create({
          data: {
            id: `${idPrefix}_payment_recovered_${key}`,
            merchantId,
            amount: plan.amountPaise,
            method: plan.paymentMethod,
            status: "CAPTURED",
            razorpayPaymentId: `pay_${refTag(idPrefix)}_E${String(plan.index).padStart(3, "0")}`,
            createdAt: paidAt,
          },
        });
        await prisma.execution.update({ where: { id: executionId }, data: { recoveredPaymentId: recoveredPayment.id } });
        const event = await prisma.paymentEvent.create({
          data: {
            paymentId: recoveredPayment.id,
            razorpayEventId: `${idPrefix}_event_${key}_link_paid`,
            eventType: "payment_link.paid",
            payload: { event: "payment_link.paid", demo: true },
            receivedAt: paidAt,
          },
        });
        await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
      } else {
        const event = await prisma.paymentEvent.create({
          data: {
            paymentId,
            razorpayEventId: `${idPrefix}_event_${key}_redelivered_failed`,
            eventType: "payment.failed",
            payload: { event: "payment.failed", demo: true },
            receivedAt: minutesAfter(executedAt, 5),
          },
        });
        await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
      }
    } else {
      controlUnits++;
      // CONTROL receives NO execution at all - matching the unconditional
      // real-architecture rule (candidateBuilder.ts's own
      // isExecutionAllowed check). 20% of CONTROL units recover on their
      // own (natural recovery); the other 80% never do.
      const recoversNaturally = controlUnits % 5 === 0;
      if (recoversNaturally) {
        const recoveredAt = minutesAfter(decidedAt, 90);
        await prisma.payment.update({ where: { id: paymentId }, data: { status: "CAPTURED", updatedAt: recoveredAt } });
        const event = await prisma.paymentEvent.create({
          data: {
            paymentId,
            razorpayEventId: `${idPrefix}_event_${key}_captured`,
            eventType: "payment.captured",
            payload: { event: "payment.captured", demo: true },
            receivedAt: recoveredAt,
          },
        });
        await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
      } else {
        const event = await prisma.paymentEvent.create({
          data: {
            paymentId,
            razorpayEventId: `${idPrefix}_event_${key}_redelivered_failed`,
            eventType: "payment.failed",
            payload: { event: "payment.failed", demo: true },
            receivedAt: minutesAfter(decidedAt, 5),
          },
        });
        await processOutcomeAttributionForPaymentEvent(event.id, undefined, now);
      }
    }
  }

  await prisma.experiment.update({
    where: { id: experimentId },
    data: { status: "COMPLETED", endedAt: windowEnd },
  });

  return { candidates: plans.length, treatmentUnits, controlUnits };
}

export async function seedDemoWorkspace(
  now: Date = new Date(),
  experimentCandidateCount: number = EXPERIMENT_CANDIDATE_COUNT,
  identity: DemoWorkspaceIdentity = DEMO_IDENTITY
): Promise<SeedDemoWorkspaceResult> {
  const config = await resolveDemoConfig(identity);
  if (config.status !== "ready") {
    return { status: "unsafe", reason: config.reason };
  }

  await ensureMerchantAndOperator(config);

  const marker = await prisma.revenueRiskEvent.findUnique({
    where: { id: demoRiskEventId(config.idPrefix, DEMO_DECISION_SCENARIOS[0].key) },
  });
  if (marker) {
    return { status: "already_seeded", merchantId: config.merchantId, operatorId: config.operatorId };
  }

  await seedDecisionScenarios(config.merchantId, config.idPrefix, now);
  const { candidates, treatmentUnits, controlUnits } = await seedExperiment(
    config.merchantId,
    config.experimentId,
    config.idPrefix,
    now,
    experimentCandidateCount
  );

  const computed = await computeExperimentResult(config.experimentId, CONFIDENCE_LEVEL, {
    now,
    minimumAnalyzableSamplePerArm: MINIMUM_ANALYZABLE_SAMPLE_PER_ARM,
  });
  if (computed.status !== "computed") {
    throw new Error("seedDemoWorkspace: the just-created demo experiment was not found when computing its result");
  }
  const persisted = await persistExperimentResult(computed.result, {
    minimumRateDifference: MINIMUM_PRACTICAL_EFFECT_RATE_DIFFERENCE,
  });
  if (persisted.status === "rejected") {
    throw new Error("seedDemoWorkspace: the computed experiment result was unexpectedly rejected at persistence");
  }

  return {
    status: "seeded",
    merchantId: config.merchantId,
    operatorId: config.operatorId,
    operatorEmail: config.operatorEmail,
    decisionScenarios: DEMO_DECISION_SCENARIOS.length,
    experimentId: config.experimentId,
    experimentCandidates: candidates,
    experimentTreatmentUnits: treatmentUnits,
    experimentControlUnits: controlUnits,
    experimentMeasurementResultStatus: persisted.record.resultStatus,
  };
}
