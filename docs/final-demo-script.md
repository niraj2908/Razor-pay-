# Final Demo Script

Target runtime **3:30–4:00**. Everything below is on the live deployment at
https://revenue-recovery-intelligence.vercel.app, commit `d50fbd6`.

**Before recording**
- Open `/demo` in a fresh window. It signs you in as the Demo Operator in one
  click, so no password appears on screen.
- Have the Security & Policies page pre-loaded in a second tab. It renders the
  real Razorpay lifecycle status from the database and is visible from any
  session, so you never switch accounts on camera.
- Do **not** run a live Razorpay checkout during the recording. The real
  execution is already verified evidence; re-running it live risks a dead
  minute.

**Standing rule for everything you say:** the Demo Workspace is synthetic, the
Razorpay Test Mode lifecycle is real, and creating a Payment Link is not the
same as recovering money.

---

## 0:00–0:20 · The problem

*No screen yet, or the login page.*

> "When a payment fails, most systems do one of two things: retry everything,
> or message everyone. Both cost money. Retries burn gateway fees and can annoy
> a customer who was already going to pay you anyway. The hard question isn't
> *can we recover this* — it's *will intervening actually create revenue that
> wouldn't have arrived on its own?*"

---

## 0:20–0:40 · The product

> "Revenue Recovery Intelligence is a governed decision layer on top of
> Razorpay. Every failed payment runs the same path: risk, decision, action,
> outcome, causal evidence, audit. It decides when to Act, Wait, Stop or
> Escalate — and it records why, every time."

---

## 0:40–1:15 · Overview / Command Center *(synthetic)*

*Open `/overview`.*

Say the label first, once, clearly:

> "This is the Demo Workspace — synthetic data, deliberately labelled as such,
> so you can see a populated console. The real Razorpay evidence comes later."

Point at: revenue at risk, recovery opportunity, decision mix, recent activity.

> "Seventy-eight payments, fifty-nine recovery candidates, fifty-nine decisions.
> The mix matters more than the volume: fifty-four Act, one Wait, two Stop, two
> Escalate. The system is willing to *not* act."

---

## 1:15–1:40 · Recovery Queue

*Open `/recovery`.*

> "Every candidate carries its diagnosis, the amount at risk, and what the
> engine decided. This is an operator's work queue, not a dashboard to admire."

Point at one row's decision badge, then click into it.

---

## 1:40–2:20 · Decision Detail — the reasoning

*Open any ACT decision.*

Point at, in order: diagnosis, model prediction, expected incremental value,
chosen action, decision context.

> "Here's the whole argument. The engine estimates recovery *without*
> intervention, and *with* it. It multiplies the difference by the amount, then
> subtracts cost. That's expected incremental value — not 'will this payment
> recover', but 'will intervening change anything'. A positive probability of
> recovery is not a reason to act."

> "Then safety and policy gates run in fixed order: already succeeded, duplicate
> execution risk, retry limit, cooldown, amount ceiling, active incident. An
> unsafe result can never be overridden into Act."

**Do not claim:** that these specific numbers came from real traffic. They are
synthetic.

---

## 2:20–3:05 · The real Razorpay evidence *(the credibility moment)*

*Open Security & Policies, the Razorpay lifecycle section.*

> "Now the real part. This status is read from the database at request time — it
> can't go stale, because it isn't prose."

Then walk the chain out loud, one breath per hop:

> "A real Razorpay Test Mode payment failed — ₹100, card, failed at
> authorization. Razorpay sent `payment.failed`. We verified the HMAC signature,
> persisted the event, and copied Razorpay's own error fields onto the payment:
> source *gateway*, step *payment_authorization*. That mapped to a diagnosis of
> network degradation. Confidence 0.75, above our policy floor. The engine
> decided **Act**, with a Payment Link. An authenticated operator clicked
> Execute — nothing here is autonomous — and Razorpay created a real Payment
> Link, `plink_TWuwKdqiR5pn5g`. Execution succeeded, with a three-event audit
> trail."

If you want one id on screen, use the decision id `cmtj5fqhj000fbt15jwg9q6hz`.

---

## 3:05–3:20 · The governance detail that matters

Still on the same evidence.

> "One detail I'd point at specifically. Retry actually scored *higher* —
> thirty-five rupees of expected value versus eight. But Razorpay has no
> retry-a-failed-payment API, so we cannot perform it. The system did not
> pretend it could. It selected the executable Payment Link and recorded Retry
> as the strategy it wanted but couldn't run. The economics stay visible; the
> decision stays honest."

---

## 3:20–3:35 · The outcome — what we do *not* claim

> "And here's what we don't say. That Payment Link is still unpaid. So the
> outcome reads **pending**, recovered amount is **null**, attribution is
> **null**. We executed a recovery. We did not recover ₹100, and the product
> refuses to claim we did. Executing is not recovering."

**Never say:** "we recovered ₹100."

---

## 3:35–3:55 · Experiments — observed versus causal *(synthetic)*

*Open `/experiments` → the demo experiment.*

> "Back in the synthetic workspace, this is how we'd prove value. Randomised
> treatment and control. Treatment recovered 81.8%, control 17.9% — a 64-point
> difference, 95% confidence interval 37 to 79 points, above our pre-set
> 15-point threshold. That's why it reads **valid effect**. Without the control
> arm, we'd have called natural recovery a win."

**Say plainly:** "This experiment is synthetic demo data, not real traffic."

---

## 3:55–4:00 · Close

> "We don't optimise for the number of interventions. We optimise for the
> amount of recovery we can safely and causally defend."

---

## If you have 20 extra seconds

- **Audit Trail** (`/audit`): filter by entity type, show `execution.requested`
  → `execution.succeeded`. "Every automated action leaves a trail."
- **Reports** (`/reports`): CSV and PDF export. "An operator can take the
  evidence with them."
- **AI Assistant** (`/assistant`): "Read-only, and every figure is labelled
  observed, estimated, or validated-causal. It cannot authorise a payment."

---

## 30-second version

> "Razorpay already knows how to retry a failed payment. What nobody answers is
> whether intervening creates revenue that wouldn't have arrived anyway.
> Revenue Recovery Intelligence is a governed decision layer that scores every
> failed payment on expected *incremental* value, applies safety and policy
> gates, and then decides Act, Wait, Stop or Escalate — recording exactly why.
> A real Razorpay Test Mode failure has run the whole path: webhook, diagnosis,
> an Act decision, an operator approval, and a real Payment Link created through
> the Razorpay API, with a full audit trail. And when the link goes unpaid, the
> system says pending rather than claiming a recovery it can't prove."

## 60-second version

> "When a payment fails, retrying everything wastes money and messaging everyone
> annoys customers who'd have paid anyway. So we built the decision layer, not
> another retry loop.
>
> Every failed payment gets diagnosed from Razorpay's own error signals, scored
> for expected *incremental* value — recovery with intervention minus recovery
> without it, times the amount, minus cost — and then run through safety and
> policy gates in a fixed order. The output is one of four things: Act, Wait,
> Stop, Escalate. No LLM is anywhere in that path; it's deterministic and
> unit-tested, because a financial decision has to be reproducible.
>
> It's real. A Razorpay Test Mode payment failed at authorization; the webhook
> was signature-verified and ingested; the failure signals were persisted and
> mapped to a diagnosis; the engine chose Act with a Payment Link; an
> authenticated operator approved it; and Razorpay created a real Payment Link,
> audited end to end.
>
> Two things we deliberately don't do. Retry scored higher, but Razorpay has no
> retry API — so we recorded it and chose the strategy we could actually
> execute. And that Payment Link is still unpaid, so the outcome reads pending,
> not recovered. We optimise for recovery we can causally defend, not for
> activity."
