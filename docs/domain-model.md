# Domain Model

This document explains `prisma/schema.prisma`. It exists so a judge — or a
teammate — can go from "what does the product do" to "where does that live in
the database" without reading migration diffs.

Frozen against Master Specification Sections 24 (database philosophy) and 25
(domain separation). Nothing here adds a concept the spec doesn't already name.

---

## The three layers (Section 25)

Every table below belongs to exactly one of these. Keeping that boundary
honest is what Section 29 (API Boundary Strategy) and ADR-004 (LLM cannot
authorize financial actions) depend on.

| Layer | Question it answers | Tables |
|---|---|---|
| **Intelligence** | What is likely to happen? | `ModelPrediction` |
| **Policy** | What should we do? | `RevenueRiskEvent`, `CandidateAction`, `Decision`, `DecisionEvidence`, `MerchantPolicy` |
| **Execution** | How do we do it? | `Execution`, `Outcome` |

Reference data (`Merchant`, `Customer`, `Order`, `Payment`, `PaymentEvent`)
and the experimentation tables (`Experiment`, `ExperimentAssignment`,
`ExperimentResult`) sit outside the three layers — they're shared context and
proof infrastructure, respectively.

---

## Entity-by-entity

### Merchant / Customer / Order / Payment
Standard reference data. `Payment.status` holds Razorpay's own reported state
(`RazorpayPaymentStatus`) — this is deliberately kept separate from our
internal diagnosis (see `RevenueRiskEvent.diagnosis` below). Razorpay telling
us a payment is `FAILED` is not the same claim as our system diagnosing it
`CONFIRMED_FAILURE` — the latter only happens after the safety check in
Section 10 ("never recover merely because payment.failed arrived").

### PaymentEvent
The raw webhook log. `razorpayEventId` is unique — this is the idempotency
mechanism required by Section 27/28. Nothing downstream reprocesses an event
whose id already exists here.

### RevenueRiskEvent
**The core unit of intelligence (Section 7).** One row per revenue-at-risk
situation. `diagnosis` uses the exact categories from Section 6's "Diagnose"
step — no extra states invented. `naturalRecoveryProbability` is Model A's
output (nullable until scored). `dataSource` implements the Section 18
disclosure requirement at the row level: every risk event knows whether it
came from real Test Mode traffic or the simulator.

### CandidateAction
The generated action set for a risk event (Section 6 "Predict"/"Decide").
`actionType` is a closed enum — the policy engine can only ever choose from
actions that have been reviewed and built, never an arbitrary string an LLM
invented. `incrementalLift` is `predictedSuccessProbability -
naturalRecoveryProbability`, the central quantity from Section 9's economic
model.

### Decision
One row per ACT/WAIT/STOP/ESCALATE choice (Section 8, exact enum values).
`chosenActionId` is null unless `decisionType == ACT`.

### DecisionEvidence
The "WHY" panel from Section 32's UI signature, stored as rows rather than
computed on the fly — this is what makes a decision auditable/inspectable
instead of a black box. `passed` is used for safety/policy checks
specifically; it's null for purely informational rows (e.g. a probability
value that isn't itself a pass/fail check).

### MerchantPolicy
Deterministic guardrails. LLM #1 (Section 15, Merchant Policy Interpreter)
writes into `config` (JSON); the decision engine reads and enforces it. The
LLM never writes directly into `Decision` or `Execution`.

### Execution / Outcome
Execution layer. `Execution.razorpayReferenceId` holds things like a Payment
Link id. `Outcome.attributedIncremental` stays null until the
experimentation layer scores whether a recovery was actually caused by the
intervention or would have happened naturally — this is the
recoverable-vs-intervention-sensitive distinction from Section 7, made
concrete as a nullable boolean rather than assumed.

### Experiment / ExperimentAssignment / ExperimentResult
The counterfactual proof engine behind **Proof 1 (Section 44)**.
`ExperimentAssignment` is 1:1 with a `RevenueRiskEvent` (a risk event belongs
to at most one active experiment's control/treatment split).
`ExperimentResult` stores per-group rollups only — the incremental GMV number
itself is a computed comparison between the `CONTROL` and `TREATMENT` rows
for an experiment, produced in the reporting layer, not stored redundantly
(avoids the two numbers silently drifting apart).

### NetworkEvent
Downtime/network degradation context (Section 7 "timing-sensitive", Section
26's `Network` node in the architecture diagram). `source` again carries the
real-vs-simulated flag from Section 18 — this table is explicitly called out
in the spec as one where simulated data is likely if a real downtime feed
isn't available.

### ModelPrediction
Every Intelligence-layer output gets logged here, including
`inputFeatures` where feasible. This is what makes an economic claim
reproducible (Section 21, Principle 8) — you can trace any `CandidateAction`
back to the exact model version and inputs that produced its probability.

### AuditEvent
Full action timeline (Section 24, UI screen 6 in Section 31).
`entityType`/`entityId` point at whatever changed; `actorType` distinguishes
system/LLM/human-initiated actions, which matters for Section 28's security
requirements around authorization.

---

## What's intentionally *not* here yet

No table for LLM #2-4's outputs (explanations, customer communication
drafts, assistant conversation history). Per the execution calendar, those
are Next-Priority-tier work — adding their tables now would be scope
creep ahead of need, which Section 21 (Principle 11: "complexity must have a
measurable reason to exist") argues against. Add them when `apps/api` first
needs to persist one.
