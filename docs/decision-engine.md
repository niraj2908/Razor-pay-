# Recovery Decision Engine (Phase 21)

Code: `apps/web/src/lib/recovery/`. This document explains the objective,
formula, and guardrails behind it, and is explicit about what today's
models are (and are not).

## 1. Why incremental recovery, not "will it succeed"

The engine does not ask "will this payment eventually succeed?" A payment
that would have recovered on its own with **no** intervention creates no
value by intervening on it - it just spends money to get an outcome that
was already going to happen. The only question worth optimizing is:

> For this payment, is intervention expected to create **incremental**
> recovered revenue, over and above what would have recovered anyway?

That is why every model in this pipeline produces a *pair* of
probabilities - natural recovery and intervention recovery - and the
economics are built from their difference, never from either one alone.

## 2. Economic formula

```
expectedIncrementalValue =
    amount
  × (P(recovery | intervention) − P(recovery | no intervention))
  − interventionCost
  − riskPenalty
```

Implemented as a pure function in `economics.ts`
(`calculateExpectedIncrementalValue`). All monetary values are integer
paise - no floating-point amounts are ever persisted, and the result is
rounded exactly once, at the final output, so rounding never compounds
across a calculation chain.

## 3. ACT / WAIT / STOP / ESCALATE

The decision space is deliberately small (`decisionEngine.ts`):

- **ACT** - intervene, with a chosen strategy (`RETRY`, `PAYMENT_LINK`, or
  `OTHER_ALLOWED_STRATEGY`). Only reachable when safety passes, policy
  allows it, confidence is high enough, and expected incremental value
  clears the policy's minimum.
- **WAIT** - do nothing for now (cooldown active, natural recovery is
  already likely, or the expected value is positive but below the action
  threshold).
- **STOP** - give up on this payment (retry limit exceeded, amount over
  the intervention limit, policy disallows the strategy, or the economics
  are non-positive).
- **ESCALATE** - hand off to a human (confidence too low to trust, or an
  active incident on a high-value payment).

These map directly onto the existing `RecoveryDecision` enum in
`prisma/schema.prisma` - no new enum was needed.

## 4. Policy engine

`policy.ts` defines a versioned `PolicyConfig` (max attempts, cooldown,
max intervention amount, customer contact limit, allowed payment methods,
allowed strategies, minimum expected value, minimum confidence).
`DEFAULT_POLICY` is tagged `"policy-v1"` - every decision trace records
this version so a historical decision stays reproducible even after the
policy configuration changes later. Versioning is a plain string tag here
(the same pattern as `modelVersion`/`featureVersion`), not a new database
table - see §7 for why.

## 5. Safety gate

`safetyGate.ts` runs **before** any ACT is considered, in a fixed priority
order, and returns on the first violation: payment already succeeded,
duplicate-execution risk, retry limit exceeded, cooldown active, amount
over the intervention limit, then active incident. An unsafe result always
overrides economics - a numerically attractive ACT is never executed
through an unsafe gate.

## 6. Model limitations (be explicit about this)

`naturalRecoveryModel.ts` and `interventionResponseModel.ts` are **hand-set
lookup tables with a retry-count decay** - not trained models. They exist
to make the pipeline's shape (context → probability → economics → policy →
safety → decision) real and testable end-to-end before any real outcome
data exists to train on.

**A production version of these models requires historical treatment/
control outcome data** - i.e. real records of "we intervened with strategy
X on a payment like this, and it did/didn't recover" versus "we didn't
intervene, and it did/didn't recover anyway." That data does not exist yet
in this system (no `Outcome` rows exist, no experiment has run). Until it
does, every number these functions produce is a transparent placeholder,
not a prediction to be trusted at face value - which is exactly why every
estimate carries an explicit `modelVersion`/`featureVersion`/`confidence`,
so a future real model can be swapped in without changing any caller.

## 7. Why no LLM in this path

The LLM must never calculate or authorize a financial value, and never
chooses the final ACT/WAIT/STOP/ESCALATE action. `economics.ts` and
`decisionEngine.ts` are ordinary, deterministic, unit-tested TypeScript -
the same input and policy version always produce the same decision. This
is a hard boundary, not a style preference: a financial decision must be
reproducible, auditable, and explainable after the fact, which an LLM call
is not guaranteed to be twice in a row.

## 8. Reused schema, no migration

Phase 21 explicitly reuses the existing domain model instead of adding new
tables:

| Phase 21 concept   | Existing Prisma model      |
|--------------------|-----------------------------|
| Recovery Candidate | `RevenueRiskEvent`           |
| Recovery Action    | `CandidateAction`             |
| Recovery Decision  | `Decision` (`ACT/WAIT/STOP/ESCALATE` already matches exactly) |
| Recovery Outcome   | `Outcome`                     |
| Model Prediction   | `ModelPrediction`             |
| Policy             | `MerchantPolicy` (config-level; not yet wired - see below) |
| Audit Event        | `AuditEvent`                  |

No migration was needed. `MerchantPolicy` exists in the schema but nothing
creates rows in it yet, because doing so requires a real `Merchant` row -
none exist in this database today (the account is pre-launch). Policy
versioning is therefore a code-level constant for now; wiring
`DEFAULT_POLICY` into `MerchantPolicy` rows is natural follow-up work once
real merchants exist, not a Phase 21 requirement.

## 9. Webhook boundary (unchanged, extended)

```
Razorpay -> webhook verification -> event persistence -> acknowledge
  -> processing boundary (processing/queue.ts, via next/server's after())
  -> recovery engine (candidateBuilder.ts)
```

The webhook route itself was not changed. `candidateBuilder.ts` explicitly
skips any `PaymentEvent` whose `payload._test_fixture.isTestFixture` is
`true` (the 7 integration-test fixtures), and separately skips any event
with no linked `Payment` row. Association/creation is handled by a later
phase (`webhooks/paymentAssociation.ts`, Phase 23 Step 3 - links an
existing Payment; Phase 25 - creates a genuinely new one under the single
configured Merchant when none exists yet, see `merchantResolution.ts`),
called from the same processing boundary immediately before this builder
runs. The builder still fails safe and skips rather than fabricating a
merchant/payment to attach to if association could not resolve one.

## 10. Execution boundary (deferred)

```
Decision Engine -> Execution Command -> Execution Service -> Razorpay Adapter -> Razorpay API
```

`execution.ts` builds a plain `{ action: "ACT", strategy, paymentId,
decisionId }` command from an ACT decision and logs it. It does **not**
call `RazorpayClient`. Actual autonomous execution is explicitly a later
phase.
