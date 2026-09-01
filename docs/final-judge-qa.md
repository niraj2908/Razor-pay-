# Judge Q&A

Answers consistent with the implementation as deployed at commit `d50fbd6`.
Where something is not proven, the answer says so.

### 1. Why isn't this just a retry system?

A retry system asks "can this payment succeed?". We ask "will intervening
create revenue that wouldn't have arrived anyway?" — a different question with a
different answer. The engine scores `amount × (P(recovery | intervention) −
P(recovery | none)) − cost − riskPenalty`. When natural recovery is already
likely, the incremental value collapses and the correct decision is to do
nothing. A retry system has no way to express that.

### 2. Why use AI/ML here?

For prediction only, never for authorisation. Two probability estimates —
recovery without intervention, and recovery with a given strategy — feed a
deterministic economic policy. Today those estimates are hand-set baseline
tables with a retry decay, and they are labelled advisory throughout, because
training them honestly needs historical treatment/control outcome data that does
not exist yet. The architecture separates prediction from policy specifically so
a trained model can replace the baseline without touching any caller.

### 3. Why is the decision engine deterministic?

Because a financial decision must be reproducible, auditable, and explainable
after the fact. `evaluateRecoveryDecision` is an ordinary unit-tested function:
same context plus same policy version always yields the same decision and the
same trace. Golden-scenario tests pin the boundaries so a change in behaviour
shows up as a failing test rather than a surprise in production.

### 4. Why didn't you let an LLM execute financial actions?

An LLM cannot guarantee it will produce the same answer twice, which makes it
unfit to authorise money movement. There is no LLM anywhere in the decision or
execution path — the assistant is read-only, template-based, and reads from the
same authorised query services the pages use. It cannot calculate a value,
choose an action, or trigger an execution.

### 5. How do you decide whether recovery is economically worthwhile?

Expected incremental value in integer paise, rounded exactly once at the end so
rounding never compounds. It must clear a policy minimum (₹1) for ACT. If it is
positive but below the threshold, the decision is WAIT; if non-positive, STOP.
Cost and a risk penalty are subtracted per strategy, so a cheap intervention on
a small amount can still fail to justify itself.

### 6. Why did PAYMENT_LINK win when RETRY had higher EIV?

Because we cannot perform a retry. Razorpay has no retry-a-failed-payment API,
so `SUPPORTED_EXECUTION_STRATEGIES` excludes it. Rather than deleting RETRY from
the model — which would hide real economics — the engine still prices it,
reports it in the trace, and then selects the best *executable* strategy,
recording the passed-over one as `unexecutableBestStrategy`. In the real
lifecycle that was RETRY at ₹35 versus PAYMENT_LINK at ₹8. If no executable
strategy is available at all, the engine escalates to a human rather than
deciding something it cannot carry out.

### 7. What happens when confidence is low?

ESCALATE. If the natural-recovery estimate's confidence is below the policy
minimum (0.5), the engine hands the decision to a human instead of acting on a
number it does not trust. That is exactly what an unrecognised failure signal
produces: it maps to `STATE_UNCERTAIN`, whose confidence is 0.35.

### 8. How do you prevent duplicate execution?

The database does it, not application logic: `Execution.decisionId` is unique.
A second trigger hits that constraint, returns the existing execution, and makes
no second Razorpay call. Verified in the real lifecycle — exactly one execution
row and one distinct Payment Link reference — and covered by an integration test
that clicks twice and asserts one API call.

### 9. How do you prevent cross-merchant access?

Isolation is the WHERE clause, never an app-code comparison. Every query is
scoped through `revenueRiskEvent: { merchantId }`, with the merchant derived
from the operator's session — no route accepts a merchant parameter. A decision
belonging to another merchant simply never matches, and returns 404 identically
to one that does not exist, so the response cannot be used to enumerate ids.
This was observed live: a demo-operator attempt to execute the Test Mode
decision returned 404 with no Razorpay call.

### 10. How is the webhook secured?

HMAC-SHA256 over the raw request bytes, compared with `timingSafeEqual`. The
body is read exactly as sent — parsing before verifying could change the bytes
and break the signature. It is the only unauthenticated route, and it
authenticates by signature instead. Delivery is idempotent on
`x-razorpay-event-id` at a unique database constraint, and the route persists
and returns before any downstream work, so recovery logic can never delay or
fail an acknowledgement.

### 11. How do you distinguish observed recovery from causal incremental recovery?

Observed recovery is a count of payments that succeeded. Causal recovery
requires a randomised control arm. Each outcome is attributed
`INTERVENTION_RECOVERY` or `NATURAL_RECOVERY`, and an experiment result may only
reach `VALID_EFFECT` under a caller-configured minimum effect threshold — a
statistically significant but practically trivial difference stays
`VALID_INCONCLUSIVE`. In the demo experiment, treatment recovered 81.8% against
a control of 17.9%; without that control arm we would have credited ourselves
with natural recovery.

### 12. Are the demo numbers real?

No, and the product says so on screen. The Demo Workspace is deterministic
synthetic data — every row is tagged `SIMULATED`, and its ids are human-readable
strings like `demo_merchant_revenue_recovery` rather than generated cuids, so no
demo row can be mistaken for a real signup. The real Razorpay evidence lives on
a separate merchant, and neither contains a row of the other's type.

### 13. Did you actually integrate with Razorpay?

Yes, in Test Mode, in both directions. Inbound: a real `payment.failed` webhook
(event `TWudu4AHIXqCGQ`), signature-verified and persisted. Outbound: a real
Payment Link, `plink_TWuwKdqiR5pn5g`, created through the Razorpay REST API by
our Execution Service, whose `reference_id` is the decision id — so the link on
Razorpay's side points back at the decision that caused it.

### 14. Did the system actually recover the ₹100?

**No.** The Payment Link it created is unpaid. The outcome is `PENDING`,
attribution is null, and the recovered amount is null. Executing a recovery and
recovering revenue are different claims, and we only make the first. If that
link is later paid, attribution still has to decide whether the payment was
incremental or would have happened anyway.

### 15. What is production-ready versus roadmap?

Production-ready: webhook ingestion and verification, diagnosis, the decision
engine with its safety and policy gates, operator-approved execution, audit
trail, merchant isolation, reports, and the read-only assistant. Roadmap:
trained models to replace the baseline tables, a durable queue in place of the
in-process boundary, retry capability if saved-token or subscription access is
granted, and causal measurement on real traffic rather than synthetic data.

### 16. What happens if Razorpay is unavailable?

Failures are classified rather than guessed. A definitive API error is a
confirmed failure; a timeout or network error is **ambiguous** and is never
treated as failed, because the request may have been processed. An ambiguous
execution is recorded as such and surfaced to the operator as "reload and
review" rather than inviting a blind retry — a duplicate Payment Link is a real
cost to a customer. On the inbound side, a database failure returns a non-2xx so
Razorpay retries delivery.

### 17. Why should a merchant trust the system?

Because it is auditable and it refuses. Every decision records the model
version, policy version, and reason code; every execution writes
requested/started/succeeded events. It will not act when natural recovery is
likely, when a payment already succeeded, when a cooldown is active, or when
confidence is too low. It will not select an action it cannot perform. It will
not execute without a human. And it does not claim revenue it cannot attribute —
the current real execution reports `PENDING`, not a win.

### 18. What would you build next?

In order: train the recovery models on the treatment/control data this system is
designed to collect; run a causal experiment on real traffic rather than
synthetic; replace the in-process processing boundary with a durable queue; and
close the loop on outcomes — a paid recovery link should flow back through
attribution automatically so the operator sees whether an intervention was
genuinely incremental.
