# Final Submission Evidence

What this project can prove, where it can be shown, and — just as important —
what it deliberately does not claim. Every row is backed by code, a test, a
database row, or a Razorpay API response. Nothing here is aspirational.

Production: https://revenue-recovery-intelligence.vercel.app · commit
`d50fbd6a457b6ac438888484a0d52a19b5e215ed` (verified via the deployment's
`meta.githubCommitSha`).

---

## Evidence matrix

| Dimension | Claim | Evidence | Where to demonstrate | Real vs synthetic | Limitation |
|---|---|---|---|---|---|
| Problem understanding | Recovery is an economic question, not a retry question: only *incremental* value justifies acting | [`economics.ts`](../apps/web/src/lib/recovery/economics.ts), [`docs/decision-engine.md`](decision-engine.md) §1–2 | Decision Detail | Both | Probabilities are hand-set baselines |
| Detection / diagnosis | Razorpay's own failure vocabulary is persisted and mapped to a diagnosis, defaulting to "uncertain" when unrecognised | [`failureReasonMapping.ts`](../apps/web/src/lib/recovery/failureReasonMapping.ts) + 22 unit tests | Decision Detail; Security page | **Real** — `error_source: gateway` → `NETWORK_DEGRADATION` | Mapping is rule-based, not learned |
| Decision quality | Four outcomes (ACT/WAIT/STOP/ESCALATE) from a deterministic pipeline; same inputs always give the same decision | [`decisionEngine.ts`](../apps/web/src/lib/recovery/decisionEngine.ts), golden-scenario tests | Decision Detail | Both | Small, deliberately closed decision space |
| Economic reasoning | `amount × (P(recovery \| intervention) − P(recovery \| none)) − cost − riskPenalty`, integer paise, rounded once | [`economics.ts`](../apps/web/src/lib/recovery/economics.ts) | Decision Detail | Both | Model inputs are baselines, advisory only |
| Safety / governance | Fixed-order safety gate; an unsafe result can never be overridden into ACT; an unexecutable strategy can never be selected | [`safetyGate.ts`](../apps/web/src/lib/recovery/safetyGate.ts), [`executableStrategies.ts`](../apps/web/src/lib/recovery/executableStrategies.ts) | Decision Detail; real evidence | **Real** — a STOP on an already-succeeded payment, with positive economics overridden | Thresholds are prototype values |
| Real payment integration | Timing-safe HMAC-SHA256 verification, idempotent ingestion on `x-razorpay-event-id`, real REST client | [`signature.ts`](../apps/web/src/lib/razorpay/signature.ts), [`route.ts`](../apps/web/src/app/api/webhooks/razorpay/route.ts), [`client.ts`](../apps/web/src/lib/razorpay/client.ts) | Security page | **Real** — event `TWudu4AHIXqCGQ` ingested 20:57:51.973Z | Test Mode only |
| Action execution | An authenticated operator executed a stored ACT decision and Razorpay created a real Payment Link | [`decisionExecutionService.ts`](../apps/web/src/lib/recovery/decisionExecutionService.ts); execution `cmtj61ovo0005z9tu731cetsc` | Security page; Audit Trail | **Real** — `plink_TWuwKdqiR5pn5g` | Operator-approved only; no autonomous loop |
| Measurement | Outcomes are attributed, not assumed: `INTERVENTION_RECOVERY` vs `NATURAL_RECOVERY` vs not recovered | [`outcomeService.ts`](../apps/web/src/lib/outcomes/outcomeService.ts) | Overview; Decision Detail | **Synthetic** — 19 intervention, 6 natural, 28 not recovered | Real merchant has too few lifecycles to measure |
| Causal attribution | Randomised control arm; `VALID_EFFECT` only under a pre-set minimum effect threshold | [`resultStatus.ts`](../apps/web/src/lib/experiments/measurement/resultStatus.ts), [`assignmentEngine.ts`](../apps/web/src/lib/experiments/assignmentEngine.ts) | Experiments | **Synthetic** — treatment 81.8% vs control 17.9%, 95% CI [37.0, 78.7] pp | Demo data only; never run on real traffic |
| Auditability | Every decision and execution writes audit events; the trail is filterable per merchant | [`decisionAuditService.ts`](../apps/web/src/lib/recovery/decisionAuditService.ts), [`activityFeedService.ts`](../apps/web/src/lib/recovery/activityFeedService.ts) | Audit Trail | **Real** — three execution audit events, 21:15:12–21:15:18Z | `DecisionEvidence` table exists but is unwritten |
| Security | `scrypt` hashing, opaque server-side sessions, merchant-scoped queries, sanitized 500s, rate limiting | [`password.ts`](../apps/web/src/lib/auth/password.ts), [`merchantAccess.ts`](../apps/web/src/lib/auth/merchantAccess.ts), [`rateLimiter.ts`](../apps/web/src/lib/rateLimit/rateLimiter.ts) | Security page | **Real** — a demo-operator execute attempt on the Test Mode decision returned 404 | No external pen-test; no certifications |
| Merchant isolation | Isolation is the WHERE clause, not an app-code check; foreign decisions are indistinguishable from missing ones | [`decisionExecutionService.ts`](../apps/web/src/lib/recovery/decisionExecutionService.ts) + integration test | Security page | **Real** — 0 real rows in Demo, 0 synthetic rows in Test Mode merchant | Single merchant per operator |
| Product quality / UX | Ten authenticated operator screens, decision-first layouts, status semantics shared across pages | `apps/web/src/app/(app)/` | Whole demo | **Synthetic** console | Desktop-first; no mobile pass |
| Engineering quality | 686 unit tests (64 files), 150 integration tests (21 files) against a real database, clean `lint`/`typecheck`/`build`, 12 migrations | `pnpm test`, `pnpm test:integration` | Repository | — | Integration suite shares one database with the deployment |
| AI / agentic reasoning | Read-only assistant grounded in the same authorized query services, labelling every figure `observed`, `estimated`, `validated_causal`, or `none` | [`assistantService.ts`](../apps/web/src/lib/assistant/assistantService.ts) | AI Assistant | **Synthetic** | Deterministic templates, not a generative model — deliberately |
| Deployment / reliability | Auto-deploys from `main`; production commit verified through the Vercel API; webhook idempotency and fail-safe processing | [`queue.ts`](../apps/web/src/lib/processing/queue.ts), [`docs/verification.md`](verification.md) | Production URL | **Real** | In-process queue, not a durable one |

---

## What we can claim

### VERIFIED IN REAL RAZORPAY TEST MODE

- Failed-payment ingestion from a genuine Razorpay failure
- `payment.failed` webhook delivery and HMAC-SHA256 signature verification
- Failure-signal persistence (`error_code`, `error_reason`, `error_source`, `error_step`)
- Diagnosis derived from those signals (`NETWORK_DEGRADATION`)
- An **ACT** decision from the deterministic engine
- Executable-strategy selection (PAYMENT_LINK chosen; RETRY recorded as unexecutable)
- Authenticated **operator-approved** execution
- Real Razorpay Payment Link creation
- Complete audit trail (`execution.requested` → `started` → `succeeded`)
- Merchant isolation, observed live: a demo-operator attempt on this decision returned 404

### VERIFIED IN SYNTHETIC DEMO DATA

- Batch recovery metrics across a populated workspace (78 payments, 59 candidates, 59 decisions, 24 executions, 53 outcomes)
- Observed recovery, split into intervention (19) and natural (6) attribution
- Validated causal incremental recovery: `VALID_EFFECT`, 95% confidence, above a 15-point minimum effect threshold
- Randomised experiment validity: 22 treatment vs 28 control units, assignment and control enforcement
- A fully populated operating console across every authenticated screen

### NOT CLAIMED

- **₹100 of real revenue recovered** from the Test Mode execution — the Payment Link is unpaid; outcome `PENDING`, attribution null, recovered amount null
- Production revenue recovered from real customers — Test Mode only, no live payments
- Trained ML performance on historical production data — the models are hand-set baselines, advisory only
- Autonomous financial execution — every execution requires an authenticated operator
- RBI authorisation, PCI-DSS certification, or DPDP compliance attestation

---

## Evidence index

Real Razorpay Test Mode lifecycle, 2026-09-01, merchant `razorpay_test_mode_merchant`:

```
payment              pay_TWuddosezaG8S2          ₹100, card, FAILED
                     error_source gateway · error_step payment_authorization

webhook              TWudu4AHIXqCGQ              payment.failed, ingested 20:57:51.973Z

risk event           f894e110-2d96-4ff1-94a2-516e06946c54
                     REAL_RAZORPAY_TEST_MODE · NETWORK_DEGRADATION
                     natural 0.55 · confidence 0.75

decision             cmtj5fqhj000fbt15jwg9q6hz   ACT, decided 20:58:07.447Z
                     PAYMENT_LINK · expected incremental value ₹8
                     policy-v1 · baseline-v1
                     unexecutableBestStrategy: RETRY (₹35, no Razorpay API)

execution            cmtj61ovo0005z9tu731cetsc   SUCCEEDED
                     executed 21:15:11.796Z · completed 21:15:17.156Z
                     audit 21:15:12.850Z / 21:15:14.943Z / 21:15:18.203Z

Razorpay link        plink_TWuwKdqiR5pn5g        created ~21:15:16Z, UNPAID

outcome              PENDING · attribution null · recovered amount null

production commit    d50fbd6a457b6ac438888484a0d52a19b5e215ed
production URL       https://revenue-recovery-intelligence.vercel.app
```

Full narrative with integrity checks: [`docs/verification.md`](verification.md) §11.
