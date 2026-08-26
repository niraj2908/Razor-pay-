# Engineering Principles

Frozen from Master Specification Section 21. These are permanent rules, not
suggestions -- a PR that violates one of these needs a documented exception,
not a silent workaround.

1. Financial decisions are never delegated directly to an LLM.
2. External events are untrusted and may be duplicated or arrive out of order.
3. Financial actions must be idempotent.
4. Unknown payment state is safer than an incorrect recovery action.
5. Every automated action has an audit trail.
6. Prediction and policy are separate concerns.
7. Synthetic data is explicitly labeled.
8. Every economic claim must be reproducible.
9. External Razorpay APIs are isolated behind adapters/interfaces.
10. AI/ML failure must degrade safely.
11. Complexity must have a measurable reason to exist.
12. No feature exists merely because it looks impressive.
