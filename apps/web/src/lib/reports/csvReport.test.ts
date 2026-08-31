import { describe, expect, it } from "vitest";
import { renderReportCsv } from "./csvReport";
import type { ReportData } from "./reportingService";

/**
 * Pure unit coverage for the CSV export (Phase 28C) - no database needed,
 * this module only formats an already-assembled `ReportData` object.
 * Real Postgres coverage for `reportingService.ts`'s own aggregations
 * lives in `reportingService.integration.test.ts`.
 */
function baseReport(overrides: Partial<ReportData> = {}): ReportData {
  return {
    generatedAt: "2026-01-01T00:00:00.000Z",
    period: { since: null, until: "2026-01-01T00:00:00.000Z" },
    paymentActivity: {
      totalCount: 2,
      totalAmountPaise: 300000,
      byStatus: { CAPTURED: { count: 1, amountPaise: 200000 }, FAILED: { count: 1, amountPaise: 100000 } },
      byMethod: [{ method: "upi", count: 2, amountPaise: 300000 }],
    },
    overview: {
      period: { since: null, until: "2026-01-01T00:00:00.000Z" },
      operational: { candidatesCount: 3, revenueAtRiskPaise: 100000, interventionsAttempted: 2, interventionsSucceeded: 1 },
      attributedOutcomes: {
        matureOutcomesCount: 2,
        recoveredCount: 1,
        naturalRecoveryCount: 1,
        interventionRecoveryCount: 0,
        unknownAttributionCount: 0,
        naturalRecoveryGmvPaise: 50000,
        interventionRecoveryGmvPaise: 0,
        observedRecoveryRate: 0.5,
      },
      incrementalRecovery: { status: "unavailable", reason: "no_experiment_configured" },
    },
    decisionMix: { ACT: 1, WAIT: 1, STOP: 0, ESCALATE: 0 },
    recoveryOpportunityPaise: 75000,
    experiments: [],
    recentActivity: [],
    ...overrides,
  };
}

describe("renderReportCsv", () => {
  it("includes every required section header", () => {
    const csv = renderReportCsv(baseReport());
    expect(csv).toContain("Executive Summary");
    expect(csv).toContain("Payment Activity");
    expect(csv).toContain("Recovery Performance");
    expect(csv).toContain("Decision Analysis");
    expect(csv).toContain("Experiment Evidence");
    expect(csv).toContain("Audit / Recent Activity");
  });

  it("escapes a field containing a comma by quoting it", () => {
    const csv = renderReportCsv(
      baseReport({
        recentActivity: [{ id: "1", entityType: "Decision", action: "decision.act", actorType: "SYSTEM", createdAt: "x", details: {} }],
        experiments: [
          {
            id: "e1",
            name: "Nudge, with a comma",
            status: "COMPLETED",
            version: "v1",
            startedAt: null,
            endedAt: null,
            createdAt: "x",
            hypothesis: null,
            description: null,
            trafficAllocationPercent: 100,
            treatmentAllocationPercent: 50,
            treatmentDefinition: "t",
            controlDefinition: "c",
            latestResult: null,
          },
        ],
      })
    );
    expect(csv).toContain('"Nudge, with a comma"');
  });

  it("escapes a field containing a double quote by doubling it", () => {
    const csv = renderReportCsv(
      baseReport({
        experiments: [
          {
            id: "e1",
            name: 'Say "hi"',
            status: "DRAFT",
            version: "v1",
            startedAt: null,
            endedAt: null,
            createdAt: "x",
            hypothesis: null,
            description: null,
            trafficAllocationPercent: 100,
            treatmentAllocationPercent: 50,
            treatmentDefinition: "t",
            controlDefinition: "c",
            latestResult: null,
          },
        ],
      })
    );
    expect(csv).toContain('"Say ""hi"""');
  });

  it("uses CRLF line endings throughout", () => {
    const csv = renderReportCsv(baseReport());
    expect(csv).toContain("\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("never fabricates a decision-mix or opportunity figure - renders exactly the input values", () => {
    const csv = renderReportCsv(baseReport({ decisionMix: { ACT: 7, WAIT: 2, STOP: 1, ESCALATE: 0 }, recoveryOpportunityPaise: 999999 }));
    expect(csv).toContain("Act,7");
    expect(csv).toContain("Wait,2");
    expect(csv).toContain("Stop,1");
    expect(csv).toContain("Escalate,0");
    expect(csv).toContain("999999");
  });
});
