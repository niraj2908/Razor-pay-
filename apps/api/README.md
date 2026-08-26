# apps/api

Node.js + TypeScript application backend (Fastify or similar).

Owns:
- Razorpay webhook ingestion (signature verification, idempotency - Section 27/28)
- Controller -> Domain Service -> Recovery Service -> Razorpay Adapter boundary (Section 29)
- Talks to services/decision-engine and services/ml-service, never embeds their logic directly
