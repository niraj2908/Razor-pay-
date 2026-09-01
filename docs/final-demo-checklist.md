# Final Demo Checklist

Screen-by-screen plan for a **3:30–4:00** recording on
https://revenue-recovery-intelligence.vercel.app (commit `d50fbd6`).

**Setup:** open `/demo` for one-click Demo Operator login (no password on
camera). Pre-load Security & Policies in a second tab — it renders the real
Razorpay lifecycle from the database and is visible from any session, so no
account switching is needed mid-demo. **Do not run a live Razorpay checkout
during the recording.**

| # | Screen | Purpose | What to show | Key sentence | Evidence type | Time |
|---|---|---|---|---|---|---|
| 1 | — (or `/login`) | Frame the problem | Nothing; speak to camera | "The question isn't *can* we recover it — it's whether intervening creates revenue that wouldn't have arrived anyway." | — | 0:20 |
| 2 | — | Frame the product | Nothing | "A governed decision layer: risk, decision, action, outcome, causal evidence, audit." | — | 0:20 |
| 3 | `/overview` | Populated operating console | Revenue at risk, recovery opportunity, decision mix, recent activity | "This is the Demo Workspace — synthetic and labelled as such. 59 decisions: 54 Act, 1 Wait, 2 Stop, 2 Escalate. The system is willing to *not* act." | **Synthetic** | 0:35 |
| 4 | `/recovery` | Operator work queue | Diagnosis, amount at risk, decision badge per row | "Every candidate carries its diagnosis and what the engine decided." | **Synthetic** | 0:25 |
| 5 | `/recovery/[id]` | The reasoning | Diagnosis → model prediction → expected incremental value → chosen action → decision context | "Expected incremental value, not probability of recovery. A positive chance of recovery is not a reason to act." | **Synthetic** | 0:40 |
| 6 | `/security` | **Real Razorpay evidence — credibility anchor** | Razorpay lifecycle status block; narrate the real chain | "A real Test Mode payment failed at authorization, the webhook was signature-verified, the engine chose Act, an operator approved it, and Razorpay created a real Payment Link." | **Real (Test Mode)** | 0:45 |
| 7 | `/security` (same view) | Governance detail | The RETRY-vs-PAYMENT_LINK point | "Retry scored higher — ₹35 against ₹8 — but Razorpay has no retry API, so the system recorded it instead of pretending it could run it." | **Real (Test Mode)** | 0:15 |
| 8 | `/security` (same view) | What we do *not* claim | Outcome pending, recovered amount null | "That link is unpaid, so the outcome reads pending. We executed a recovery; we did not recover ₹100." | **Real (Test Mode)** | 0:15 |
| 9 | `/experiments/demoexperimentpaymentlinknudge` | Observed vs causal | Treatment 81.8% vs control 17.9%, 95% CI, VALID_EFFECT | "Without the control arm we'd have called natural recovery a win. This is synthetic demo data." | **Synthetic** | 0:20 |
| 10 | — | Close | Nothing | "We don't optimise for the number of interventions. We optimise for recovery we can safely and causally defend." | — | 0:05 |

**Running total: ≈ 3:40.**

## Optional, only if you are ahead of time

| Screen | What to show | Key sentence | Time |
|---|---|---|---|
| `/audit` | Filter by entity type; `execution.requested` → `execution.succeeded` | "Every automated action leaves a trail." | 0:15 |
| `/reports` | CSV and PDF export | "An operator can take the evidence with them." | 0:10 |
| `/assistant` | A question, and the `observed` / `estimated` / `validated_causal` labels | "Read-only. It cannot authorise a payment, and it labels what kind of number each figure is." | 0:15 |

## Screens available in production (verified present)

`/login` · `/signup` · `/demo` (one-click demo login) · `/overview` ·
`/recovery` · `/recovery/[decisionId]` · `/recovery/[decisionId]/audit` ·
`/audit` · `/experiments` · `/experiments/[experimentId]` · `/reports` ·
`/assistant` · `/security`

## Things to never say on camera

- "We recovered ₹100." The Payment Link is unpaid.
- "These numbers are from real merchants." The populated console is synthetic.
- "The AI decides." No LLM is in the decision path; the engine is deterministic.
- "It runs autonomously." Execution requires an authenticated operator click.
- "It's production-ready for live payments." It is a Test Mode prototype with no
  RBI, PCI-DSS or DPDP certification.

## Fallback if something fails live

- **Deployment slow or unreachable:** the evidence in `docs/verification.md` §11
  carries every id and timestamp; narrate from it.
- **A screen looks empty:** the Demo Workspace may have been reset — say so
  plainly rather than reloading repeatedly, and move to the real evidence.
- **Never** attempt a live payment to fill a gap. The verified evidence stands
  on its own.
