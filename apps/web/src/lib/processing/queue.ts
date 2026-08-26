import { after } from "next/server";
import { buildRecoveryCandidateFromPaymentEvent } from "@/lib/recovery/candidateBuilder";
import { associatePaymentEvent } from "@/lib/webhooks/paymentAssociation";

export type ProcessingJob = {
  paymentEventId: string;
  eventType: string;
};

export interface ProcessingQueue {
  enqueue(job: ProcessingJob): void;
}

/**
 * Application-level processing boundary. The webhook route calls `enqueue`
 * and returns immediately - it must never await recovery/decision logic.
 *
 * This is deliberately NOT a real queue yet: `enqueue` currently calls the
 * recovery decision engine in-process rather than publishing to a real
 * queue client (SQS, BullMQ, etc.) - swapping that in later requires no
 * change to callers.
 *
 * `next/server`'s `after()` runs its callback once the response has been
 * sent, without delaying that response - unlike a bare fire-and-forget
 * promise, it is guaranteed to run to completion even in serverless
 * runtimes that would otherwise freeze the process right after the
 * response is returned.
 */
class InProcessQueue implements ProcessingQueue {
  enqueue(job: ProcessingJob): void {
    after(async () => {
      console.log("[processing] processing started", job);
      try {
        const association = await associatePaymentEvent(job.paymentEventId);
        console.log("[processing] payment association result", {
          paymentEventId: job.paymentEventId,
          ...association,
        });
      } catch (error) {
        // Fail safe: an association failure must never surface as a
        // webhook failure (the response is already sent).
        console.error("[processing] payment association failed", {
          paymentEventId: job.paymentEventId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
      try {
        const result = await buildRecoveryCandidateFromPaymentEvent(job.paymentEventId);
        console.log("[processing] recovery candidate result", {
          paymentEventId: job.paymentEventId,
          ...result,
        });
      } catch (error) {
        // Fail safe: a recovery-engine failure must never surface as a
        // webhook failure (the response is already sent) and must never
        // trigger a financial action on its own.
        console.error("[processing] recovery candidate failed", {
          paymentEventId: job.paymentEventId,
          error: error instanceof Error ? error.message : "unknown_error",
        });
      }
      console.log("[processing] processing completed", job);
    });
  }
}

export const processingQueue: ProcessingQueue = new InProcessQueue();
