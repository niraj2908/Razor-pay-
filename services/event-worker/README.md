# services/event-worker

Async worker (Redis/BullMQ) that processes queued Razorpay events end to end:
Event Gateway -> State Engine -> Feature Engine -> Recovery Intelligence -> Policy Gateway -> Razorpay Adapter (Section 26).

Must handle: duplicate webhook, out-of-order webhook, delayed webhook, partial execution (Section 27).
