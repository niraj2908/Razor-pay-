import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `vi.mock` factories are hoisted above all top-level `const` declarations,
 * so the mock functions and their shared in-memory store must be created
 * inside `vi.hoisted()` to be safely referenced from the factories below.
 *
 * The store simulates real Postgres unique-constraint semantics on
 * Execution.decisionId (not our own check-then-insert): `create` performs
 * its has()/set() check SYNCHRONOUSLY, with no await beforehand, so
 * concurrent calls (Promise.all) race exactly the way concurrent DB
 * connections would - only the first writer for a given decisionId wins.
 */
const mocks = vi.hoisted(() => {
  type StoredExecution = {
    id: string;
    decisionId: string;
    paymentId: string;
    actionType: string;
    status: string;
    razorpayReferenceId: string | null;
  };

  const executionStore = new Map<string, StoredExecution>();
  let idCounter = 0;

  const executionCreate = vi.fn(async ({ data }: { data: Omit<StoredExecution, "id" | "razorpayReferenceId"> }) => {
    if (executionStore.has(data.decisionId)) {
      const error = new Error("Unique constraint failed on the fields: (`decisionId`)") as Error & {
        code: string;
      };
      error.code = "P2002";
      throw error;
    }
    const row: StoredExecution = { id: `execution_${++idCounter}`, razorpayReferenceId: null, ...data };
    executionStore.set(data.decisionId, row);
    return row;
  });

  const executionFindUniqueOrThrow = vi.fn(async ({ where }: { where: { decisionId: string } }) => {
    const row = executionStore.get(where.decisionId);
    if (!row) throw new Error("Execution not found");
    return row;
  });

  const executionUpdate = vi.fn(
    async ({ where, data }: { where: { id: string }; data: Partial<StoredExecution> }) => {
      const row = [...executionStore.values()].find((r) => r.id === where.id);
      if (!row) throw new Error("Execution not found");
      Object.assign(row, data);
      return row;
    }
  );

  return {
    executionStore,
    reset: () => {
      executionStore.clear();
      idCounter = 0;
    },
    executionCreate,
    executionFindUniqueOrThrow,
    executionUpdate,
    paymentFindUnique: vi.fn(),
    decisionFindUnique: vi.fn(),
    auditEventCreate: vi.fn(async () => ({ id: "audit_1" })),
    paymentLinksCreate: vi.fn(),
    paymentsFetch: vi.fn(),
    paymentsCapture: vi.fn(),
  };
});

vi.mock("@/lib/db", () => ({
  prisma: {
    execution: {
      create: mocks.executionCreate,
      findUniqueOrThrow: mocks.executionFindUniqueOrThrow,
      update: mocks.executionUpdate,
    },
    payment: { findUnique: mocks.paymentFindUnique },
    decision: { findUnique: mocks.decisionFindUnique },
    auditEvent: { create: mocks.auditEventCreate },
  },
}));

vi.mock("@/lib/razorpay/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/razorpay/client")>("@/lib/razorpay/client");
  return {
    ...actual, // keep the real RazorpayApiError/RazorpayTimeoutError classes
    RazorpayClient: {
      paymentLinks: { create: mocks.paymentLinksCreate },
      payments: { fetch: mocks.paymentsFetch, capture: mocks.paymentsCapture },
    },
  };
});

const { executeCommand } = await import("./executionService");
import type { ExecutionCommand } from "./executionService";
import { RazorpayApiError, RazorpayTimeoutError } from "@/lib/razorpay/client";

function makeCommand(overrides: Partial<ExecutionCommand> = {}): ExecutionCommand {
  return {
    decisionId: "decision_1",
    paymentId: "pay_1",
    action: "ACT",
    strategy: "PAYMENT_LINK",
    policyVersion: "policy-v1",
    decidedAt: new Date().toISOString(),
    amount: 10000,
    ...overrides,
  };
}

describe("executeCommand", () => {
  beforeEach(() => {
    mocks.reset();
    vi.clearAllMocks();
    mocks.paymentFindUnique.mockResolvedValue({
      id: "pay_1",
      merchantId: "merchant_1",
      status: "FAILED",
      razorpayPaymentId: "pay_razorpay_1",
    });
    // Default: no ExperimentAssignment at all - matches every pre-existing
    // (pre-Phase-23-Step-5) test in this file, none of which set up an
    // experiment. This is the "NO ASSIGNMENT" case, never CONTROL.
    mocks.decisionFindUnique.mockResolvedValue({
      id: "decision_1",
      revenueRiskEvent: { experimentAssignment: null },
    });
  });

  function mockAssignmentArm(decisionId: string, arm: "CONTROL" | "TREATMENT" | null) {
    mocks.decisionFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id !== decisionId) return { id: where.id, revenueRiskEvent: { experimentAssignment: null } };
      return {
        id: decisionId,
        revenueRiskEvent: { experimentAssignment: arm ? { arm } : null },
      };
    });
  }

  describe("structural validation", () => {
    it("rejects action=WAIT with strategy=PAYMENT_LINK", async () => {
      const result = await executeCommand(makeCommand({ action: "WAIT" }));
      expect(result).toEqual({ status: "rejected", reason: "action_not_executable" });
      expect(mocks.executionCreate).not.toHaveBeenCalled();
    });

    it("rejects action=STOP with strategy=CAPTURE", async () => {
      const result = await executeCommand(makeCommand({ action: "STOP", strategy: "CAPTURE" }));
      expect(result).toEqual({ status: "rejected", reason: "action_not_executable" });
    });

    it("rejects the RETRY strategy - Razorpay has no retry API (Phase 22 Step 1)", async () => {
      const result = await executeCommand(makeCommand({ strategy: "RETRY" }));
      expect(result).toEqual({ status: "rejected", reason: "unsupported_strategy" });
    });

    it("rejects a structurally invalid command (zero amount) without touching the database", async () => {
      const result = await executeCommand(makeCommand({ amount: 0 }));
      expect(result).toEqual({ status: "rejected", reason: "invalid_amount" });
      expect(mocks.executionCreate).not.toHaveBeenCalled();
    });

    it("rejects a stale decision", async () => {
      const result = await executeCommand(
        makeCommand({ decidedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
      );
      expect(result).toEqual({ status: "rejected", reason: "decision_stale" });
    });
  });

  describe("PAYMENT_LINK", () => {
    it("1. valid ACT + PAYMENT_LINK calls the Razorpay adapter and succeeds", async () => {
      mocks.paymentLinksCreate.mockResolvedValue({ id: "plink_1", shortUrl: "https://rzp.io/i/x", status: "created" });

      const result = await executeCommand(makeCommand());

      expect(mocks.paymentLinksCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10000, referenceId: "decision_1" })
      );
      expect(result).toEqual({ status: "succeeded", executionId: "execution_1", razorpayReferenceId: "plink_1" });
    });

    it("3. already-captured payment -> no API call", async () => {
      mocks.paymentFindUnique.mockResolvedValue({ id: "pay_1", merchantId: "m1", status: "CAPTURED", razorpayPaymentId: "p1" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_captured" }));

      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "skipped", executionId: "execution_1", reason: "payment_already_succeeded" });
    });

    it("4. an existing SUCCEEDED execution is returned - no API call", async () => {
      mocks.executionStore.set("decision_done", {
        id: "execution_prior",
        decisionId: "decision_done",
        paymentId: "pay_1",
        actionType: "PAYMENT_LINK",
        status: "SUCCEEDED",
        razorpayReferenceId: "plink_prior",
      });

      const result = await executeCommand(makeCommand({ decisionId: "decision_done" }));

      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "existing", executionId: "execution_prior", executionStatus: "SUCCEEDED" });
    });

    it("5. a PENDING execution is returned - no duplicate API call", async () => {
      mocks.executionStore.set("decision_pending", {
        id: "execution_prior",
        decisionId: "decision_pending",
        paymentId: "pay_1",
        actionType: "PAYMENT_LINK",
        status: "PENDING",
        razorpayReferenceId: null,
      });

      const result = await executeCommand(makeCommand({ decisionId: "decision_pending" }));

      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "existing", executionId: "execution_prior", executionStatus: "PENDING" });
    });

    it("6. an AMBIGUOUS execution is returned - no duplicate API call", async () => {
      mocks.executionStore.set("decision_ambiguous", {
        id: "execution_prior",
        decisionId: "decision_ambiguous",
        paymentId: "pay_1",
        actionType: "PAYMENT_LINK",
        status: "AMBIGUOUS",
        razorpayReferenceId: null,
      });

      const result = await executeCommand(makeCommand({ decisionId: "decision_ambiguous" }));

      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "existing", executionId: "execution_prior", executionStatus: "AMBIGUOUS" });
    });

    it("7. a Razorpay 4xx is classified and recorded as FAILED", async () => {
      mocks.paymentLinksCreate.mockRejectedValue(new RazorpayApiError(400, "bad request"));

      const result = await executeCommand(makeCommand({ decisionId: "decision_4xx" }));

      expect(result).toEqual({ status: "failed", executionId: "execution_1", errorCategory: "validation_error" });
    });

    it("8. a Razorpay 5xx is handled safely as FAILED (not auto-retried)", async () => {
      mocks.paymentLinksCreate.mockRejectedValue(new RazorpayApiError(500, "internal error"));

      const result = await executeCommand(makeCommand({ decisionId: "decision_5xx" }));

      expect(result).toEqual({ status: "failed", executionId: "execution_1", errorCategory: "server_error" });
      expect(mocks.paymentLinksCreate).toHaveBeenCalledTimes(1); // never auto-retried
    });

    it("9. a timeout is recorded as AMBIGUOUS, never FAILED, with no automatic retry", async () => {
      mocks.paymentLinksCreate.mockRejectedValue(new RazorpayTimeoutError());

      const result = await executeCommand(makeCommand({ decisionId: "decision_timeout" }));

      expect(result).toEqual({
        status: "ambiguous",
        executionId: "execution_1",
        errorCategory: "network_timeout",
      });
      expect(mocks.paymentLinksCreate).toHaveBeenCalledTimes(1);
      expect(mocks.executionStore.get("decision_timeout")?.status).toBe("AMBIGUOUS");
    });
  });

  describe("CAPTURE", () => {
    it("10. an authorized payment is fetched, then captured", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "authorized", amount: 10000, currency: "INR" });
      mocks.paymentsCapture.mockResolvedValue({ id: "pay_razorpay_1", status: "captured", amount: 10000, currency: "INR" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_capture", strategy: "CAPTURE" }));

      expect(mocks.paymentsFetch).toHaveBeenCalledWith("pay_razorpay_1");
      expect(mocks.paymentsCapture).toHaveBeenCalledWith("pay_razorpay_1", 10000, "INR");
      expect(result).toEqual({
        status: "succeeded",
        executionId: "execution_1",
        razorpayReferenceId: "pay_razorpay_1",
      });
    });

    it("11. an already-captured payment (per Razorpay's live state) is not captured again", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "captured", amount: 10000, currency: "INR" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_already_captured", strategy: "CAPTURE" }));

      expect(mocks.paymentsCapture).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: "skipped",
        executionId: "execution_1",
        reason: "payment_not_authorized:captured",
      });
    });

    it("12. a failed payment (per Razorpay's live state) is never captured", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "failed", amount: 10000, currency: "INR" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_failed_state", strategy: "CAPTURE" }));

      expect(mocks.paymentsCapture).not.toHaveBeenCalled();
      expect(result.status).toBe("skipped");
    });

    it("13. a refunded payment is never captured", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "refunded", amount: 10000, currency: "INR" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_refunded", strategy: "CAPTURE" }));

      expect(mocks.paymentsCapture).not.toHaveBeenCalled();
      expect(result.status).toBe("skipped");
    });

    it("14. a Razorpay capture failure is recorded as FAILED", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "authorized", amount: 10000, currency: "INR" });
      mocks.paymentsCapture.mockRejectedValue(new RazorpayApiError(400, "already captured"));

      const result = await executeCommand(makeCommand({ decisionId: "decision_capture_fail", strategy: "CAPTURE" }));

      expect(result).toEqual({ status: "failed", executionId: "execution_1", errorCategory: "validation_error" });
    });

    it("15. a capture timeout is recorded as AMBIGUOUS", async () => {
      mocks.paymentsFetch.mockResolvedValue({ id: "pay_razorpay_1", status: "authorized", amount: 10000, currency: "INR" });
      mocks.paymentsCapture.mockRejectedValue(new RazorpayTimeoutError());

      const result = await executeCommand(makeCommand({ decisionId: "decision_capture_timeout", strategy: "CAPTURE" }));

      expect(result).toEqual({
        status: "ambiguous",
        executionId: "execution_1",
        errorCategory: "network_timeout",
      });
    });
  });

  describe("concurrency", () => {
    it("16. five simultaneous PAYMENT_LINK calls for the same decision result in exactly one Razorpay call", async () => {
      mocks.paymentLinksCreate.mockResolvedValue({ id: "plink_race", shortUrl: "https://rzp.io/i/race", status: "created" });
      const commands = Array.from({ length: 5 }, () => makeCommand({ decisionId: "decision_race" }));

      const results = await Promise.all(commands.map((command) => executeCommand(command)));

      expect(mocks.paymentLinksCreate).toHaveBeenCalledTimes(1);
      const succeededOrExisting = results.filter((r) => r.status === "succeeded" || r.status === "existing");
      expect(succeededOrExisting).toHaveLength(5);
      expect(mocks.executionStore.size).toBe(1);
    });
  });

  // Phase 23 Step 5 hardening: defense-in-depth CONTROL enforcement inside
  // the Execution Service itself (isControlArmForbidden), independent of
  // the processing-layer gate in experimentService.ts.
  describe("experiment control enforcement (defense-in-depth)", () => {
    it("1/2/3. CONTROL is rejected before any Execution row or Razorpay call", async () => {
      mockAssignmentArm("decision_control", "CONTROL");

      const result = await executeCommand(makeCommand({ decisionId: "decision_control" }));

      expect(result).toEqual({ status: "rejected", reason: "control_arm_forbidden" });
      expect(mocks.executionCreate).not.toHaveBeenCalled(); // 2. zero Execution rows
      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled(); // 3. zero Razorpay calls
      expect(mocks.paymentsFetch).not.toHaveBeenCalled();
      expect(mocks.paymentsCapture).not.toHaveBeenCalled();
      expect(mocks.executionStore.size).toBe(0);
    });

    it("4. TREATMENT proceeds through the existing execution behavior unchanged", async () => {
      mockAssignmentArm("decision_treatment", "TREATMENT");
      mocks.paymentLinksCreate.mockResolvedValue({ id: "plink_treatment", shortUrl: "https://rzp.io/i/t", status: "created" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_treatment" }));

      expect(mocks.paymentLinksCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10000, referenceId: "decision_treatment" })
      );
      expect(result).toMatchObject({ status: "succeeded", razorpayReferenceId: "plink_treatment" });
    });

    it("5. NO assignment (no ExperimentAssignment at all) proceeds through existing execution behavior unchanged", async () => {
      // Uses the beforeEach default (experimentAssignment: null) - the same
      // shape every pre-Step-5 caller of executeCommand produces today.
      mocks.paymentLinksCreate.mockResolvedValue({ id: "plink_none", shortUrl: "https://rzp.io/i/n", status: "created" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_1" }));

      expect(mocks.paymentLinksCreate).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ status: "succeeded", razorpayReferenceId: "plink_none" });
    });

    it("6. a caller cannot override CONTROL by attaching a fake TREATMENT/arm field to the command - ExecutionCommand has no such field and the service re-resolves from the database regardless", async () => {
      mockAssignmentArm("decision_spoofed", "CONTROL");
      const spoofedCommand = { ...makeCommand({ decisionId: "decision_spoofed" }), arm: "TREATMENT", experimentId: "exp_fake" };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await executeCommand(spoofedCommand as any);

      expect(result).toEqual({ status: "rejected", reason: "control_arm_forbidden" });
      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
    });

    it("7. concurrent CONTROL execution attempts all reject - none reserves an Execution row", async () => {
      mockAssignmentArm("decision_control_race", "CONTROL");
      const commands = Array.from({ length: 5 }, () => makeCommand({ decisionId: "decision_control_race" }));

      const results = await Promise.all(commands.map((command) => executeCommand(command)));

      expect(results.every((r) => r.status === "rejected")).toBe(true);
      expect(mocks.executionCreate).not.toHaveBeenCalled();
      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(mocks.executionStore.size).toBe(0);
    });

    it("9. a TREATMENT-assigned but structurally invalid command is still rejected (existing structural validation remains authoritative)", async () => {
      mockAssignmentArm("decision_treatment_invalid", "TREATMENT");

      const result = await executeCommand(makeCommand({ decisionId: "decision_treatment_invalid", amount: 0 }));

      expect(result).toEqual({ status: "rejected", reason: "invalid_amount" });
      expect(mocks.decisionFindUnique).not.toHaveBeenCalled(); // structural validation runs BEFORE the CONTROL check
    });

    it("10. a TREATMENT-assigned but already-captured payment is still skipped (existing payment-eligibility check remains authoritative)", async () => {
      mockAssignmentArm("decision_treatment_captured", "TREATMENT");
      mocks.paymentFindUnique.mockResolvedValue({ id: "pay_1", merchantId: "m1", status: "CAPTURED", razorpayPaymentId: "p1" });

      const result = await executeCommand(makeCommand({ decisionId: "decision_treatment_captured" }));

      expect(mocks.paymentLinksCreate).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "skipped", executionId: "execution_1", reason: "payment_already_succeeded" });
    });
  });
});
