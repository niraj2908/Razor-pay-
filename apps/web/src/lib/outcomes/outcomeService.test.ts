import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const paymentEvents = new Map<string, Row>();
  const payments = new Map<string, Row>();
  const executions = new Map<string, Row>();
  const decisions = new Map<string, Row>();
  const riskEvents = new Map<string, Row>();
  const outcomes = new Map<string, Row>();
  let idCounter = 0;

  const paymentEventFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => paymentEvents.get(where.id) ?? null);

  const executionFindMany = vi.fn(async ({ where }: { where: Record<string, string> }) => {
    const [key, value] = Object.entries(where)[0];
    return [...executions.values()].filter((e) => e[key] === value);
  });
  const executionFindUnique = vi.fn(async ({ where }: { where: { decisionId: string } }) =>
    [...executions.values()].find((e) => e.decisionId === where.decisionId) ?? null
  );

  const revenueRiskEventFindMany = vi.fn(async ({ where }: { where: { paymentId: string } }) => {
    const matches = [...riskEvents.values()].filter((r) => r.paymentId === where.paymentId);
    return matches.map((r) => ({ ...r, decisions: [...decisions.values()].filter((d) => d.revenueRiskEventId === r.id) }));
  });

  const decisionFindUniqueOrThrow = vi.fn(async ({ where }: { where: { id: string } }) => {
    const decision = decisions.get(where.id);
    if (!decision) throw new Error("Decision not found");
    const revenueRiskEvent = riskEvents.get(decision.revenueRiskEventId as string);
    return { ...decision, revenueRiskEvent };
  });

  const paymentFindUniqueOrThrow = vi.fn(async ({ where }: { where: { id: string } }) => {
    const payment = payments.get(where.id);
    if (!payment) throw new Error("Payment not found");
    return payment;
  });
  const paymentFindUnique = vi.fn(async ({ where }: { where: { id: string } }) => payments.get(where.id) ?? null);

  const outcomeCreate = vi.fn(async ({ data }: { data: Row }) => {
    if ([...outcomes.values()].some((o) => o.decisionId === data.decisionId)) {
      const error = new Error("Unique constraint failed on the fields: (`decisionId`)") as Error & { code: string };
      error.code = "P2002";
      throw error;
    }
    const row = { id: `outcome_${++idCounter}`, ...data };
    outcomes.set(row.id, row);
    return row;
  });
  const outcomeFindUniqueOrThrow = vi.fn(async ({ where }: { where: { decisionId: string } }) => {
    const row = [...outcomes.values()].find((o) => o.decisionId === where.decisionId);
    if (!row) throw new Error("Outcome not found");
    return row;
  });
  const outcomeUpdate = vi.fn(async ({ where, data }: { where: { id: string }; data: Row }) => {
    const row = outcomes.get(where.id);
    if (!row) throw new Error("Outcome not found");
    Object.assign(row, data);
    return row;
  });

  const auditEventCreate = vi.fn(async () => ({ id: "audit_1" }));

  return {
    paymentEvents,
    payments,
    executions,
    decisions,
    riskEvents,
    outcomes,
    reset: () => {
      paymentEvents.clear();
      payments.clear();
      executions.clear();
      decisions.clear();
      riskEvents.clear();
      outcomes.clear();
      idCounter = 0;
    },
    paymentEventFindUnique,
    executionFindMany,
    executionFindUnique,
    revenueRiskEventFindMany,
    decisionFindUniqueOrThrow,
    paymentFindUniqueOrThrow,
    paymentFindUnique,
    outcomeCreate,
    outcomeFindUniqueOrThrow,
    outcomeUpdate,
    auditEventCreate,
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    paymentEvent: { findUnique: mocks.paymentEventFindUnique },
    execution: { findMany: mocks.executionFindMany, findUnique: mocks.executionFindUnique },
    revenueRiskEvent: { findMany: mocks.revenueRiskEventFindMany },
    decision: { findUniqueOrThrow: mocks.decisionFindUniqueOrThrow },
    payment: { findUniqueOrThrow: mocks.paymentFindUniqueOrThrow, findUnique: mocks.paymentFindUnique },
    outcome: {
      create: mocks.outcomeCreate,
      findUniqueOrThrow: mocks.outcomeFindUniqueOrThrow,
      update: mocks.outcomeUpdate,
    },
    auditEvent: { create: mocks.auditEventCreate },
  },
}));

const { processOutcomeAttributionForPaymentEvent } = await import("./outcomeService");
import { DEFAULT_ATTRIBUTION_POLICY } from "./attributionEngine";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const DECIDED_AT = new Date("2025-12-31T23:00:00.000Z"); // 1 hour before NOW

describe("processOutcomeAttributionForPaymentEvent", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
  });

  it("skips a PaymentEvent that does not exist", async () => {
    const result = await processOutcomeAttributionForPaymentEvent("evt_missing");
    expect(result).toEqual({ status: "skipped_not_found" });
  });

  it("skips a marked Test Mode fixture", async () => {
    mocks.paymentEvents.set("evt_fixture", { id: "evt_fixture", paymentId: null, payload: { _test_fixture: { isTestFixture: true } } });
    const result = await processOutcomeAttributionForPaymentEvent("evt_fixture");
    expect(result).toEqual({ status: "skipped_fixture" });
  });

  it("skips an unlinked PaymentEvent (paymentId still null)", async () => {
    mocks.paymentEvents.set("evt_unlinked", { id: "evt_unlinked", paymentId: null, payload: {} });
    const result = await processOutcomeAttributionForPaymentEvent("evt_unlinked");
    expect(result).toEqual({ status: "skipped_unlinked" });
  });

  it("reports no_relevant_decisions when nothing references the linked payment", async () => {
    mocks.payments.set("payment_orphan", { id: "payment_orphan", status: "CAPTURED", amount: 10000 });
    mocks.paymentEvents.set("evt_orphan", { id: "evt_orphan", paymentId: "payment_orphan", payload: {} });
    const result = await processOutcomeAttributionForPaymentEvent("evt_orphan");
    expect(result).toEqual({ status: "no_relevant_decisions" });
  });

  it("creates a NATURAL_RECOVERY Outcome for a Decision found via RevenueRiskEvent (no execution)", async () => {
    mocks.payments.set("payment_1", { id: "payment_1", status: "CAPTURED", amount: 10000 });
    mocks.riskEvents.set("risk_1", { id: "risk_1", paymentId: "payment_1" });
    mocks.decisions.set("decision_1", { id: "decision_1", revenueRiskEventId: "risk_1", decidedAt: DECIDED_AT });
    mocks.paymentEvents.set("evt_1", { id: "evt_1", paymentId: "payment_1", payload: {} });

    const result = await processOutcomeAttributionForPaymentEvent("evt_1", DEFAULT_ATTRIBUTION_POLICY, NOW);

    expect(result.status).toBe("processed");
    if (result.status === "processed") {
      expect(result.decisionResults[0]).toMatchObject({ status: "created", decisionId: "decision_1", outcomeStatus: "RECOVERED" });
    }
    const outcome = [...mocks.outcomes.values()][0];
    expect(outcome.attributionStatus).toBe("NATURAL_RECOVERY");
  });

  it("finds the Decision via Execution.recoveredPaymentId (Payment Link recovery case)", async () => {
    mocks.payments.set("payment_original", { id: "payment_original", status: "FAILED", amount: 10000 });
    mocks.payments.set("payment_recovered", { id: "payment_recovered", status: "CAPTURED", amount: 10000 });
    mocks.riskEvents.set("risk_1", { id: "risk_1", paymentId: "payment_original" });
    mocks.decisions.set("decision_1", { id: "decision_1", revenueRiskEventId: "risk_1", decidedAt: DECIDED_AT });
    mocks.executions.set("execution_1", {
      id: "execution_1",
      decisionId: "decision_1",
      paymentId: "payment_original",
      recoveredPaymentId: "payment_recovered",
      actionType: "PAYMENT_LINK",
      status: "SUCCEEDED",
    });
    mocks.paymentEvents.set("evt_plink_paid", { id: "evt_plink_paid", paymentId: "payment_recovered", payload: {} });

    const result = await processOutcomeAttributionForPaymentEvent("evt_plink_paid", DEFAULT_ATTRIBUTION_POLICY, NOW);

    expect(result.status).toBe("processed");
    const outcome = [...mocks.outcomes.values()][0];
    expect(outcome).toMatchObject({ decisionId: "decision_1", status: "RECOVERED", attributionStatus: "INTERVENTION_RECOVERY" });
  });

  it("never regresses a terminal RECOVERED outcome on re-evaluation (idempotent, DB-unique-based)", async () => {
    mocks.payments.set("payment_1", { id: "payment_1", status: "CAPTURED", amount: 10000 });
    mocks.riskEvents.set("risk_1", { id: "risk_1", paymentId: "payment_1" });
    mocks.decisions.set("decision_1", { id: "decision_1", revenueRiskEventId: "risk_1", decidedAt: DECIDED_AT });
    mocks.paymentEvents.set("evt_1", { id: "evt_1", paymentId: "payment_1", payload: {} });
    mocks.paymentEvents.set("evt_2", { id: "evt_2", paymentId: "payment_1", payload: {} });

    const first = await processOutcomeAttributionForPaymentEvent("evt_1", DEFAULT_ATTRIBUTION_POLICY, NOW);
    expect(first.status).toBe("processed");

    // A second, later event referencing the SAME payment re-triggers evaluation.
    const second = await processOutcomeAttributionForPaymentEvent("evt_2", DEFAULT_ATTRIBUTION_POLICY, NOW);
    expect(second.status).toBe("processed");
    if (second.status === "processed") {
      expect(second.decisionResults[0].status).toBe("skipped_terminal");
    }
    expect(mocks.outcomes.size).toBe(1); // never a second Outcome row
  });
});
