import { beforeEach, describe, expect, it, vi } from "vitest";

const buildRecoveryCandidateFromPaymentEvent = vi.fn();

vi.mock("@/lib/recovery/candidateBuilder", () => ({
  buildRecoveryCandidateFromPaymentEvent,
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
  });

  it("calls the recovery candidate builder with the job's paymentEventId", async () => {
    buildRecoveryCandidateFromPaymentEvent.mockResolvedValue({ status: "skipped_fixture" });

    processingQueue.enqueue({ paymentEventId: "evt_1", eventType: "payment.captured" });
    await vi.waitFor(() => expect(buildRecoveryCandidateFromPaymentEvent).toHaveBeenCalledWith("evt_1"));
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
