import { after } from "next/server";

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
 * This is deliberately NOT a real queue yet: no recovery, decision, or
 * policy engine exists in this codebase (see README - all marked
 * "Planned"). Building one out here would recreate exactly the "entire
 * recovery engine inside the webhook request" this boundary exists to
 * prevent. `enqueue` currently just marks the processing lifecycle so it's
 * observable; swapping the body of `enqueue` for a real queue client (SQS,
 * BullMQ, etc.) later requires no change to callers.
 *
 * `next/server`'s `after()` runs its callback once the response has been
 * sent, without delaying that response - unlike a bare fire-and-forget
 * promise, it is guaranteed to run to completion even in serverless
 * runtimes that would otherwise freeze the process right after the
 * response is returned.
 */
class InProcessQueue implements ProcessingQueue {
  enqueue(job: ProcessingJob): void {
    after(() => {
      console.log("[processing] processing started", job);
      console.log("[processing] processing completed", job);
    });
  }
}

export const processingQueue: ProcessingQueue = new InProcessQueue();
