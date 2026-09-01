# Revenue Recovery Intelligence

An economic decision layer for failed-payment recovery, built on Razorpay for
the Razorpay AI Buildathon 2026 (Track 3 — AI Revenue Recovery).

> Revenue Recovery Intelligence doesn't blindly retry failed payments. It
> decides when to **Act**, **Wait**, **Stop**, or **Escalate**, applies safety
> and policy gates, records the reasoning, and measures whether recovery was
> actually incremental.

Razorpay already knows how to retry a payment. The unanswered question is
whether intervening on a specific payment creates revenue that would not have
arrived anyway — and this system is built to answer that question, refuse to
act when the answer is no, and prove the difference afterwards.

---

## Live deployment

| | |
|---|---|
| Production URL | https://revenue-recovery-intelligence.vercel.app |
| Deployment | `revenue-recovery-intelligence-lmkpxlzig.vercel.app` (Ready, Production) |
| Commit deployed | `352418b` |
| Verified | 1 September 2026 |

The Demo Workspace operator account (`demo-operator@revenue-recovery.demo`) is
seeded from `DEMO_OPERATOR_PASSWORD`; the password is an environment secret and
is deliberately not printed in this repository.

## What this system does

1. **Ingests real Razorpay events.** `POST /api/webhooks/razorpay` verifies an
   HMAC-SHA256 signature in constant time, deduplicates on
   `x-razorpay-event-id`, persists a `PaymentEvent`, and returns before doing
   any downstream work.
2. **Turns failures into risk.** Association resolves the merchant and payment,
   then a `RevenueRiskEvent` is created with a diagnosis and the amount at risk,
   tagged `SIMULATED` or `REAL_RAZORPAY_TEST_MODE` — never both.
3. **Decides economically.** For each candidate action:

   ```
   expectedIncrementalValue =
       amount × ( P(recovery | intervention) − P(recovery | no intervention) )
     − interventionCost
     − riskPenalty
   ```

   A positive probability of recovery is not a reason to act; only positive
   *incremental* value is.
4. **Gates on safety and policy.** A deterministic safety gate runs in fixed
   priority order — already succeeded, duplicate execution risk, retry limit,
   cooldown, amount ceiling, active incident — and an unsafe result can never be
   overridden into ACT.
5. **Records why.** Every decision writes `DecisionEvidence` and audit events;
   the Decision Detail page renders the reasoning the engine actually used.
6. **Measures causality.** Randomized treatment/control assignment with 95%
   confidence intervals, where a result may only reach `VALID_EFFECT` under an
   explicitly configured minimum-effect threshold — natural recovery is never
   allowed to read as lift.
7. **Explains, read-only.** The Assistant answers operational questions from the
   same authorized query services the pages use, and labels every figure as
   `observed`, `estimated`, `validated_causal`, or `none`.

## Verified status (1 September 2026)

| Check | Result |
|---|---|
| Unit tests (`pnpm test`, 61 files) | **640 passed** |
| Integration tests (`pnpm test:integration`, 20 files) | **142 passed, 1 failed** — see below |
| `pnpm typecheck` | clean |
| `pnpm build` | clean (Next.js 16, Turbopack) |
| Production deployment | Ready, serving `352418b` |

The one failing integration test is
`src/lib/recovery/executionService.integration.test.ts`, which creates a real
Razorpay Test Mode Payment Link through the Execution Service. It fails today
because the Razorpay Test Mode API key currently configured for this
deployment is rejected by Razorpay with `401 BAD_REQUEST_ERROR:
Authentication failed`. This is a credential problem, not a code path problem —
but until a working key is configured, outbound execution against Razorpay is
**not** currently verifiable, and this README does not claim it is.

## What is real vs simulated

| Component | Status | Detail |
|---|---|---|
| Payment webhook ingestion | **Real, verified** | Idempotent on `x-razorpay-event-id`; real Test Mode deliveries persisted |
| Webhook signature verification | **Real, verified** | Timing-safe HMAC-SHA256 ([`signature.ts`](apps/web/src/lib/razorpay/signature.ts)) |
| Merchant association & risk creation | **Real, verified** | Real event produced a `RevenueRiskEvent` tagged `REAL_RAZORPAY_TEST_MODE` |
| Decision engine (ACT/WAIT/STOP/ESCALATE) | **Real, verified** | Ran on the real event and produced a STOP ([`decisionEngine.ts`](apps/web/src/lib/recovery/decisionEngine.ts)) |
| Safety and policy gates | **Real, verified** | [`safetyGate.ts`](apps/web/src/lib/recovery/safetyGate.ts), [`policy.ts`](apps/web/src/lib/recovery/policy.ts) |
| Outcome attribution & audit trail | **Real, verified** | Real decision carries an outcome attributed `NATURAL_RECOVERY`, plus audit events |
| Reports (CSV / PDF) | **Real** | [`csvReport.ts`](apps/web/src/lib/reports/csvReport.ts), [`pdfReport.ts`](apps/web/src/lib/reports/pdfReport.ts) |
| Experiments & causal measurement | **Real, on synthetic data** | Randomized assignment and `VALID_EFFECT` measurement run over the Demo Workspace |
| Payment Link creation (ACT execution) | **Implemented, not currently verified** | Code and a controlled integration test exist; the configured Test Mode key returns 401, and no production route or UI control calls `executeCommand` yet |
| Autonomous execution loop | **Not built** | Execution is deliberately operator-free for now; see [`docs/decision-engine.md`](docs/decision-engine.md) §10 |
| Recovery probability models | **Cold-start baselines** | Hand-set lookup tables with retry decay ([`naturalRecoveryModel.ts`](apps/web/src/lib/recovery/naturalRecoveryModel.ts)); every estimate carries `modelVersion`/`confidence` |
| Tokenized card auto-retry | **Not built** | Requires saved-token/subscription access on a live merchant account |
| Trained ML pipeline | **Not built** | Needs historical treatment/control outcomes that do not exist yet |

## Razorpay lifecycle evidence

A real payment in Razorpay Test Mode travelled this chain, and the rows are in
the database (merchant `razorpay_test_mode_merchant`, decided
2026-09-01T11:17:17Z):

```
Razorpay Test Mode payment
  → webhook delivery
  → HMAC-SHA256 verification
  → PaymentEvent persisted
  → merchant association
  → RevenueRiskEvent (dataSource = REAL_RAZORPAY_TEST_MODE, diagnosis STATE_UNCERTAIN)
  → Decision Engine
  → STOP
  → outcome attribution (RECOVERED, attributed NATURAL_RECOVERY)
  → audit event
  → UI and CSV/PDF reports
```

**The chain is verified up to and including outcome attribution. ACT execution
against real Razorpay is not verified**: the engine's real-data decision was
STOP, the account's API key currently fails authentication, and no production
caller invokes the execution service. The Security & Policies page derives this
status from the database at request time
([`lifecycleVerification.ts`](apps/web/src/lib/razorpay/lifecycleVerification.ts))
rather than asserting it in prose, so it cannot go stale.

## Demo Workspace

Deterministic, clearly-synthetic, and isolated from the real Test Mode merchant.
Every row is tagged `SIMULATED`; ids are human-readable strings such as
`demo_merchant_revenue_recovery`, never generated cuids, so no demo row can be
mistaken for a real signup.

Contents verified in the database on 1 September 2026:

| Entity | Count |
|---|---|
| Payments | 78 |
| Payment events | 53 |
| Revenue risk events | 59 |
| Candidate actions | 117 |
| Decisions | 59 |
| Executions | 24 |
| Outcomes | 53 |
| Model predictions | 117 |
| Audit events | 59 |
| Experiments | 1 (one `VALID_EFFECT` final measurement result) |

```bash
pnpm --filter web db:seed:demo    # idempotent seed
pnpm --filter web db:reset:demo   # remove the workspace
```

The integration suite builds its own throwaway workspace identity, so a test's
cleanup can never delete the workspace an evaluator is looking at. The suite
still writes to the same database, so run the demo seed **after** the tests,
never before.

## Repository layout

Everything that runs in production lives in `apps/web` — a single Next.js 16
application serving both the operator UI and every server route.

```
apps/web/src/app/(app)/       Overview, Recovery Queue, Decision Detail,
                              Experiments, Reports, Audit, Assistant, Security
apps/web/src/app/api/         Route handlers (webhook, recovery, experiments,
                              reports, assistant, auth)
apps/web/src/lib/recovery/    Decision engine, economics, policy, safety gate,
                              execution service, audit
apps/web/src/lib/experiments/ Assignment engine and causal measurement
apps/web/src/lib/razorpay/    Signature, REST client, connection + lifecycle status
apps/web/src/lib/demo/        Deterministic Demo Workspace seed and reset
prisma/schema.prisma          21-model PostgreSQL domain model, 11 migrations
```

`apps/api`, `services/*`, `packages/*`, and the root `ml/`, `simulator/`, and
`experiments/` folders are **placeholders from the original specification's
layout** — they contain README files describing intended ownership and no
implementation. They are kept because they document where work would move if
the web app were split, not because they run.

## Setup

```bash
cp .env.example .env          # fill in Razorpay Test Mode credentials
docker-compose up -d          # Postgres and Redis (or point DATABASE_URL elsewhere)
pnpm install
pnpm db:migrate
pnpm dev
```

Required environment variables are documented in `.env.example`. Prisma loads
`.env` (not `.env.local`), so the credentials the application and tests actually
use are the ones in `.env`.

## Reproducing the verification

```bash
pnpm test                                # 640 unit tests, no database
pnpm typecheck && pnpm build             # clean
pnpm --filter web test:integration       # 143 tests against DATABASE_URL (~8 min)
pnpm --filter web db:seed:demo           # run LAST — the suite resets its own demo rows
```

## Security posture

- Every merchant-scoped query is filtered by `merchantId`; operators resolve to
  exactly one merchant through `merchantAccess.ts`, enforced at the route
  boundary before any service call.
- The webhook route is the only unauthenticated endpoint; it authenticates by
  HMAC signature instead, and rejects unverifiable bodies before parsing.
- Passwords are hashed with `scrypt`; sessions are opaque server-side tokens.
- No LLM is in the financial decision path at all — the Assistant is read-only
  and template-based, and cannot calculate, authorize, or choose an action.
- Secrets stay server-side; `.env` files are gitignored and excluded from
  deployment uploads.

See [SECURITY.md](SECURITY.md) and [ENGINEERING_PRINCIPLES.md](ENGINEERING_PRINCIPLES.md).

## Known limitations

- Recovery probabilities are hand-set baselines, not trained models.
- ACT executions are not wired to a production trigger, and outbound Razorpay
  calls are currently blocked by an invalid Test Mode API key.
- Causal measurement has so far been exercised on synthetic Demo Workspace data;
  the real Test Mode merchant has one lifecycle, which is far too little to
  measure anything.
- The processing "queue" is a synchronous in-process boundary, not a durable
  queue.
- One merchant per operator; no organisations, roles, or invitations.

## Documentation

- [docs/verification.md](docs/verification.md) — what was run, when, and what it produced
- [docs/decision-engine.md](docs/decision-engine.md) — economics, decision space, gates
- [docs/domain-model.md](docs/domain-model.md) — entity-by-entity schema rationale
- [docs/authentication.md](docs/authentication.md) — auth and merchant isolation
- [JUDGING_MATRIX.md](JUDGING_MATRIX.md) — criterion-by-criterion evidence
