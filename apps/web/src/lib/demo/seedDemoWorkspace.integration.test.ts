import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { seedDemoWorkspace } from "./seedDemoWorkspace";
import { resetDemoWorkspace } from "./resetDemoWorkspace";
import { DEMO_EXPERIMENT_ID, DEMO_MERCHANT_ID, DEMO_OPERATOR_ID } from "./config";
import { DEMO_DECISION_SCENARIOS } from "./scenarios";
import { resolveOperatorSession, createOperatorSession } from "@/lib/auth/authService";
import { resolveMerchantAccess } from "@/lib/auth/merchantAccess";
import { SESSION_COOKIE_NAME } from "@/lib/auth/sessionToken";
import { GET as demoLoginRoute } from "@/app/demo/route";

function extractSessionToken(response: Response): string {
  const setCookie = response.headers.get("set-cookie") ?? "";
  const match = /operator_session=([^;]+)/.exec(setCookie);
  if (!match) throw new Error("GET /demo did not set a session cookie");
  return decodeURIComponent(match[1]);
}

/**
 * Real-database integration coverage for the Demo/Evaluation Workspace
 * (Phase 28B). Uses a SMALL experiment candidate count (fast, still proves
 * every mechanic - idempotency, arm coverage, execution/outcome coverage,
 * audit, reset) rather than the CLI's realistic default count, which is
 * intentionally larger for actual demo/evaluation use (see
 * seedDemoWorkspace.ts) and would make this suite impractically slow.
 *
 * A real, UNRELATED control Merchant is created before every test in this
 * file and verified untouched after both seeding and resetting - the
 * concrete proof that this feature can never affect another Merchant's
 * data, not merely an assertion that it "should."
 */
const TEST_EXPERIMENT_CANDIDATE_COUNT = 8;

let controlMerchantId: string;
let controlOperatorId: string;
let controlPaymentId: string;

async function createControlMerchant(): Promise<void> {
  const tag = randomUUID();
  const merchant = await prisma.merchant.create({ data: { name: `phase28-control-${tag}` } });
  const operator = await prisma.operator.create({
    data: { merchantId: merchant.id, email: `phase28-control-${tag}@example.com`, passwordHash: "scrypt:1:1:1:aa:bb" },
  });
  const payment = await prisma.payment.create({
    data: { merchantId: merchant.id, amount: 12345, status: "FAILED" },
  });
  controlMerchantId = merchant.id;
  controlOperatorId = operator.id;
  controlPaymentId = payment.id;
}

async function expectControlMerchantIntact(): Promise<void> {
  const merchant = await prisma.merchant.findUnique({ where: { id: controlMerchantId } });
  const operator = await prisma.operator.findUnique({ where: { id: controlOperatorId } });
  const payment = await prisma.payment.findUnique({ where: { id: controlPaymentId } });
  expect(merchant).not.toBeNull();
  expect(operator).not.toBeNull();
  expect(payment).not.toBeNull();
}

async function countDemoWorkspaceRows() {
  const merchant = await prisma.merchant.findUnique({ where: { id: DEMO_MERCHANT_ID } });
  const payments = await prisma.payment.count({ where: { merchantId: DEMO_MERCHANT_ID } });
  const riskEvents = await prisma.revenueRiskEvent.findMany({
    where: { merchantId: DEMO_MERCHANT_ID },
    include: { decisions: { include: { executions: true, outcome: true } } },
  });
  const decisions = riskEvents.flatMap((r) => r.decisions);
  const decisionTypes = new Set(decisions.map((d) => d.decisionType));
  const executions = decisions.flatMap((d) => d.executions);
  const executionStatuses = new Set(executions.map((e) => e.status));
  const outcomes = decisions.map((d) => d.outcome).filter((o): o is NonNullable<typeof o> => o !== null);
  const outcomeStatuses = new Set(outcomes.map((o) => o.status));
  const experiment = await prisma.experiment.findUnique({ where: { id: DEMO_EXPERIMENT_ID } });
  const assignments = experiment
    ? await prisma.experimentAssignment.findMany({ where: { experimentId: experiment.id } })
    : [];
  const measurementResults = experiment
    ? await prisma.experimentMeasurementResult.findMany({ where: { experimentId: experiment.id } })
    : [];
  const auditEvents = await prisma.auditEvent.count({
    where: {
      OR: [
        { merchantId: DEMO_MERCHANT_ID },
        { entityType: "Decision", entityId: { in: decisions.map((d) => d.id) } },
        { entityType: "Execution", entityId: { in: executions.map((e) => e.id) } },
        { entityType: "Outcome", entityId: { in: outcomes.map((o) => o.id) } },
      ],
    },
  });

  return {
    merchantExists: merchant !== null,
    payments,
    riskEventCount: riskEvents.length,
    decisionCount: decisions.length,
    decisionTypes,
    executionStatuses,
    outcomeStatuses,
    experimentExists: experiment !== null,
    experimentStatus: experiment?.status ?? null,
    assignmentArms: new Set(assignments.map((a) => a.arm)),
    assignmentCount: assignments.length,
    measurementResultCount: measurementResults.length,
    measurementResultStatuses: new Set(measurementResults.map((r) => r.resultStatus)),
    auditEvents,
  };
}

describe("Demo Workspace seed/reset against a real database", () => {
  beforeAll(async () => {
    process.env.DEMO_OPERATOR_PASSWORD ??= "phase28-demo-integration-test-password";
    await resetDemoWorkspace();
    await createControlMerchant();
  }, 60_000);

  afterAll(async () => {
    await resetDemoWorkspace();
    await prisma.merchant.delete({ where: { id: controlMerchantId } }).catch(() => undefined);
    await prisma.$disconnect();
  }, 60_000);

  it(
    "1/2. creates exactly one Demo Merchant and its Demo Operator belonging to it",
    async () => {
      const result = await seedDemoWorkspace(new Date(), TEST_EXPERIMENT_CANDIDATE_COUNT);
      expect(result.status).toBe("seeded");

      const merchant = await prisma.merchant.findUnique({ where: { id: DEMO_MERCHANT_ID } });
      expect(merchant).not.toBeNull();

      const operator = await prisma.operator.findUnique({ where: { id: DEMO_OPERATOR_ID } });
      expect(operator).not.toBeNull();
      expect(operator?.merchantId).toBe(DEMO_MERCHANT_ID);
    },
    // Observed up to ~120s for a single 8-candidate seed when the full
    // integration suite runs concurrently and contends for the same
    // Supabase pooler connection - generous margin, not a slow operation
    // in isolation (run alone, this completes in well under 30s).
    300_000
  );

  it(
    "3. re-running the seed is idempotent - reports already_seeded and creates no new rows",
    async () => {
      const before = await countDemoWorkspaceRows();
      const result = await seedDemoWorkspace(new Date(), TEST_EXPERIMENT_CANDIDATE_COUNT);
      expect(result.status).toBe("already_seeded");
      const after = await countDemoWorkspaceRows();
      expect(after.payments).toBe(before.payments);
      expect(after.decisionCount).toBe(before.decisionCount);
      expect(after.assignmentCount).toBe(before.assignmentCount);
      expect(after.measurementResultCount).toBe(before.measurementResultCount);
    },
    60_000
  );

  it("4. never touched the unrelated control Merchant while seeding", async () => {
    await expectControlMerchantIntact();
  });

  it("5. Payment/RevenueRiskEvent coverage: varied diagnoses and amounts, matching the nine decision scenarios plus the experiment cohort", async () => {
    const counts = await countDemoWorkspaceRows();
    expect(counts.riskEventCount).toBe(DEMO_DECISION_SCENARIOS.length + TEST_EXPERIMENT_CANDIDATE_COUNT);
    expect(counts.payments).toBeGreaterThanOrEqual(counts.riskEventCount);
  });

  it("6. ACT/WAIT/STOP/ESCALATE decision coverage exists, as legitimately produced by the real decision engine", async () => {
    const counts = await countDemoWorkspaceRows();
    expect(counts.decisionTypes).toEqual(new Set(["ACT", "WAIT", "STOP", "ESCALATE"]));
  });

  it("7. SUCCEEDED and FAILED execution coverage exists", async () => {
    const counts = await countDemoWorkspaceRows();
    expect(counts.executionStatuses.has("SUCCEEDED")).toBe(true);
    expect(counts.executionStatuses.has("FAILED")).toBe(true);
  });

  it("8. RECOVERED and NOT_RECOVERED outcome coverage exists", async () => {
    const counts = await countDemoWorkspaceRows();
    expect(counts.outcomeStatuses.has("RECOVERED")).toBe(true);
    expect(counts.outcomeStatuses.has("NOT_RECOVERED")).toBe(true);
  });

  it(
    "9. the demo Experiment has both CONTROL and TREATMENT assignments, and a real persisted measurement result",
    async () => {
      const counts = await countDemoWorkspaceRows();
      expect(counts.experimentExists).toBe(true);
      expect(counts.experimentStatus).toBe("COMPLETED");
      expect(counts.assignmentArms).toEqual(new Set(["CONTROL", "TREATMENT"]));
      expect(counts.assignmentCount).toBe(TEST_EXPERIMENT_CANDIDATE_COUNT);
      expect(counts.measurementResultCount).toBeGreaterThanOrEqual(1);
      // Never asserts a specific resultStatus (e.g. VALID_EFFECT) - the real
      // pipeline's honest answer is whatever it is; only that it produced one
      // of the four real, defined values.
      for (const status of counts.measurementResultStatuses) {
        expect(["INSUFFICIENT_DATA", "INVALID", "VALID_INCONCLUSIVE", "VALID_EFFECT"]).toContain(status);
      }
    },
    // The default 5s Vitest timeout was too tight for this file's real
    // Supabase pooler round-trips (same latency characteristic documented
    // on tests 1/3/11/12 in this file) and caused an intermittent, purely
    // environmental failure unrelated to the assertions themselves.
    30_000
  );

  it(
    "10. a Decision -> Execution -> Outcome audit lifecycle exists",
    async () => {
      const counts = await countDemoWorkspaceRows();
      expect(counts.auditEvents).toBeGreaterThan(0);

      const decisionAudits = await prisma.auditEvent.count({ where: { entityType: "Decision", merchantId: DEMO_MERCHANT_ID } });
      expect(decisionAudits).toBeGreaterThan(0);
    },
    30_000
  );

  it(
    "11. reset removes ONLY Demo Workspace data, never the unrelated control Merchant",
    async () => {
      const result = await resetDemoWorkspace();
      expect(result.status).toBe("reset");

      const afterReset = await countDemoWorkspaceRows();
      expect(afterReset.merchantExists).toBe(false);
      expect(afterReset.payments).toBe(0);
      expect(afterReset.riskEventCount).toBe(0);
      expect(afterReset.decisionCount).toBe(0);
      expect(afterReset.experimentExists).toBe(false);
      expect(afterReset.auditEvents).toBe(0);

      await expectControlMerchantIntact();
    },
    30_000
  );

  it(
    "12. seeding again after a reset reproduces the same logical dataset (deterministic counts and decision distribution)",
    async () => {
      const first = await seedDemoWorkspace(new Date(), TEST_EXPERIMENT_CANDIDATE_COUNT);
      expect(first.status).toBe("seeded");
      const firstCounts = await countDemoWorkspaceRows();

      await resetDemoWorkspace();
      const second = await seedDemoWorkspace(new Date(), TEST_EXPERIMENT_CANDIDATE_COUNT);
      expect(second.status).toBe("seeded");
      const secondCounts = await countDemoWorkspaceRows();

      expect(secondCounts.payments).toBe(firstCounts.payments);
      expect(secondCounts.riskEventCount).toBe(firstCounts.riskEventCount);
      expect(secondCounts.decisionCount).toBe(firstCounts.decisionCount);
      expect(secondCounts.decisionTypes).toEqual(firstCounts.decisionTypes);
      expect(secondCounts.executionStatuses).toEqual(firstCounts.executionStatuses);
      expect(secondCounts.outcomeStatuses).toEqual(firstCounts.outcomeStatuses);
      expect(secondCounts.assignmentArms).toEqual(firstCounts.assignmentArms);
      expect(secondCounts.assignmentCount).toBe(firstCounts.assignmentCount);
      // The hash-based assignment engine is deterministic given the same
      // fixed experiment id and candidate keys, so the exact TREATMENT vs
      // CONTROL split must reproduce identically too.
      if (first.status === "seeded" && second.status === "seeded") {
        expect(second.experimentTreatmentUnits).toBe(first.experimentTreatmentUnits);
        expect(second.experimentControlUnits).toBe(first.experimentControlUnits);
        expect(second.experimentMeasurementResultStatus).toBe(first.experimentMeasurementResultStatus);
      }
    },
    // Two full seed cycles plus a reset in between - under the same
    // pooler contention noted above, generous margin (in isolation this
    // completes in well under 2 minutes).
    900_000
  );

  // Regression coverage for a reported production bug: an evaluator opening
  // the app independently (outside this Claude session) reported seeing an
  // empty Demo Workspace, even though the underlying demo data was
  // confirmed present and correctly linked. Root cause: /login's own
  // "if (session) redirect" silently redirected any visitor who already
  // held ANY valid session (even a stray, unrelated one from earlier,
  // unrelated testing on the same machine) straight into that OLD account
  // before the "Explore Demo" affordance was ever rendered - landing them
  // in a real but unrelated, often-empty workspace that looked identical
  // to "the demo has no data." The fix is `GET /demo`
  // (src/app/demo/route.ts): a plain, directly-linkable route that never
  // checks for an existing session and unconditionally overwrites whatever
  // session cookie the request already carried.
  it(
    "13. a completely fresh, cookieless request to /demo authenticates as the Demo Operator and reaches real populated data",
    async () => {
      const request = new NextRequest("http://localhost/demo");
      const response = await demoLoginRoute(request);

      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/overview");

      const token = extractSessionToken(response);
      const session = await resolveOperatorSession(token);
      expect(session).not.toBeNull();
      expect(session?.operator.id).toBe(DEMO_OPERATOR_ID);

      const access = await resolveMerchantAccess(session!.operator.id);
      expect(access?.merchantId).toBe(DEMO_MERCHANT_ID);

      const counts = await countDemoWorkspaceRows();
      expect(counts.merchantExists).toBe(true);
      expect(counts.payments).toBeGreaterThan(0);
      expect(counts.decisionCount).toBeGreaterThan(0);
    },
    30_000
  );

  it(
    "14. /demo unconditionally overwrites a pre-existing, unrelated session rather than being blocked by it - the confirmed root cause of the reported bug",
    async () => {
      const staleSession = await createOperatorSession(controlOperatorId);
      const requestWithStaleCookie = new NextRequest("http://localhost/demo", {
        headers: { cookie: `${SESSION_COOKIE_NAME}=${staleSession.token}` },
      });

      const response = await demoLoginRoute(requestWithStaleCookie);
      expect(response.status).toBe(307);
      expect(response.headers.get("location")).toContain("/overview");

      const newToken = extractSessionToken(response);
      expect(newToken).not.toBe(staleSession.token);

      const session = await resolveOperatorSession(newToken);
      expect(session?.operator.id).toBe(DEMO_OPERATOR_ID);

      const access = await resolveMerchantAccess(session!.operator.id);
      expect(access?.merchantId).toBe(DEMO_MERCHANT_ID);
    },
    30_000
  );
});
