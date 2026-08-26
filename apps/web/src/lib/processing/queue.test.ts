import { beforeEach, describe, expect, it, vi } from "vitest";

const buildRecoveryCandidateFromPaymentEvent = vi.fn();
const associatePaymentEvent = vi.fn();

vi.mock("@/lib/recovery/candidateBuilder", () => ({
  buildRecoveryCandidateFromPaymentEvent,
}));

vi.mock("@/lib/webhooks/paymentAssociation", () => ({
  associatePaymentEvent,
}));

// `after()` needs a real Next.js request scope - run its callback
// immediately instead, matching route.test.ts's approach.
vi.mock("next/server", () => ({
  after: (callback: () => void) => callback(),
}));

const { processingQueue } = await import("./queue");

describe("processingQueue.enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    associatePaymentEvent.mockResolvedValue({ status: "unassociated", reason: "unsupported_event_type_for_association" });
    buildRecoveryCandidateFromPaymentEvent.mockResolvedValue({ status: "skipped_fixture" });
  });

  it("calls the payment association step with the job's paymentEventId", async () => {
    processingQueue.enqueue({ paymentEventId: "evt_1", eventType: "payment.captured" });
    await vi.waitFor(() => expect(associatePaymentEvent).toHaveBeenCalledWith("evt_1"));
  });

  it("calls the recovery candidate builder with the job's paymentEventId", async () => {
    processingQueue.enqueue({ paymentEventId: "evt_1", eventType: "payment.captured" });
    await vi.waitFor(() => expect(buildRecoveryCandidateFromPaymentEvent).toHaveBeenCalledWith("evt_1"));
  });

  it("still runs the recovery candidate builder even when association fails (Phase 23 fail-safe)", async () => {
    associatePaymentEvent.mockRejectedValue(new Error("db unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    processingQueue.enqueue({ paymentEventId: "evt_3", eventType: "payment.captured" });

    await vi.waitFor(() => expect(buildRecoveryCandidateFromPaymentEvent).toHaveBeenCalledWith("evt_3"));
    expect(errorSpy).toHaveBeenCalledWith(
      "[processing] payment association failed",
      expect.objectContaining({ paymentEventId: "evt_3" })
    );
    errorSpy.mockRestore();
  });

  it("never throws even when the recovery engine fails (Phase 21.16 fail-safe)", async () => {
    buildRecoveryCandidateFromPaymentEvent.mockRejectedValue(new Error("db unreachable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      processingQueue.enqueue({ paymentEventId: "evt_2", eventType: "payment.failed" })
    ).not.toThrow();

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith(
        "[processing] recovery candidate failed",
        expect.objectContaining({ paymentEventId: "evt_2" })
      )
    );
    errorSpy.mockRestore();
  });
});
