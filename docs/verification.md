# Verification Log

What was actually run to finalize this project, when, and what it produced.
Every number here came from a command in this repository or a query against the
database the deployment uses. Nothing in this file is estimated.

**Date:** 1-2 September 2026
**Commits:** passes verified at `352418b`, `a9f613d`, `aef5059`, and the executable-strategy work in §9
**Branch:** `main`

This log was written in four passes. The first ran against `352418b`; a second
followed after the Razorpay Test Mode credentials were replaced and two defects
were fixed; a third (§8) records the failure-diagnosis work that made ACT
reachable for real traffic; a fourth (§9) records the executable-strategy fix
that followed from it. Where an earlier pass's finding was later
superseded, the entry says so rather than being quietly deleted.

## 1. Static checks

| Command | Result |
|---|---|
| `pnpm lint` | clean |
| `pnpm typecheck` | clean (forced, uncached) |
| `pnpm build` | clean — Next.js 16.3.3, Turbopack, all routes compiled |
| `prisma validate` | schema valid |
| `prisma migrate status` | 12 migrations, database schema up to date |

`turbo run build typecheck` in **parallel** fails with `TS2307: Cannot find
module './routes.js'` — the two tasks race on `.next/types`. Run them
sequentially. This is a task-ordering artefact, not a code defect.

One local-only obstacle was removed first: an untracked scratch file,
`apps/web/src/lib/demo/__counts.ts`, left over from an earlier debugging
session, failed type checking (`TS2322` on an `ExperimentAssignment.groupBy`
field name). It was never committed, so it never affected deployments; it was
moved out of the working tree rather than committed or ignored.

## 2. Unit tests

`pnpm test` (in `apps/web`) — **63 files, 671 tests, all passing**, ~5s, no
database access.

## 3. Integration tests

`pnpm test:integration` (in `apps/web`) — **20 files, 145 tests**, ~7-8 minutes
against the live Postgres pooler.

**Final state: all 143 pass.** Getting there surfaced two genuine problems and
one piece of infrastructure noise, recorded here in the order they were found.

### 3.1 Razorpay credentials (resolved)

`src/lib/recovery/executionService.integration.test.ts` initially failed with
`expected 'failed' to be 'succeeded'`. That test drives `executeCommand` →
Razorpay adapter → Razorpay Test Mode to create a real ₹1 Payment Link. The
cause was credentials, not code: the configured Test Mode key was rejected by
Razorpay with `401 BAD_REQUEST_ERROR: Authentication failed` on every endpoint
tried.

A replacement Test Mode key was configured. A read-only probe through the
application's own adapter (`RazorpayClient.payments.fetch` on an id that cannot
exist) then returned `400 The id provided does not exist` rather than `401`,
proving authentication without writing anything. The test passes.

Note that Prisma loads `.env` and ignores `.env.local`, so `.env` is the file
the application and the test suite actually read.

### 3.2 Unscoped audit deletion in test cleanup (fixed)

`executionService.integration.test.ts` then failed a second time inside the
full suite while passing in isolation, on
`expect(actions).toContain("execution.requested")`. Two `afterAll` hooks were
deleting audit events by `entityType` alone, unscoped to the rows they had
created:

- `executionService.controlEnforcement.integration.test.ts` — every
  `entityType: "Execution"` row in the database.
- `experimentService.integration.test.ts` — every
  `entityType: "ExperimentAssignment"` row.

Vitest runs files in parallel, so the first could fire mid-flight and delete the
rows another test was about to assert on. Worse, the suite shares one database
with local development and the deployment, so it had already destroyed the Demo
Workspace's execution audit trail: 24 executions with zero audit events, despite
the demo seed writing two per execution.

Both hooks now resolve the ids they created and scope the delete to those ids.
The Demo Workspace was then reset and reseeded through the project's own CLI,
restoring 48 execution audit events (two per execution). No row was written by
hand.

### 3.3 Pooler connection drops (infrastructure)

One suite run failed `outcomeService.integration.test.ts` ("five concurrent
attribution attempts converge on exactly one Outcome") with `Can't reach
database server at …:6543`. Rerun in isolation: 6/6 passed. The remote pooler
drops connections under concurrent load; rerun the file rather than reading it
as a defect.

## 4. Database evidence

Queried directly through Prisma after the integration suite finished.

### Real Razorpay Test Mode merchant (`razorpay_test_mode_merchant`)

| Entity | Count |
|---|---|
| Payments | 1 |
| Payment events | 1 |
| Revenue risk events | 1 (`dataSource = REAL_RAZORPAY_TEST_MODE`) |
| Candidate actions | 2 |
| Decisions | 1 |
| Executions | 0 |
| Outcomes | 1 |
| Audit events | 1 |

The single real decision:

```
2026-09-01T11:17:17.831Z  STOP  diagnosis=STATE_UNCERTAIN
executions=[]  outcome={status: RECOVERED, attributionStatus: NATURAL_RECOVERY}
```

The real-data chain is verified from webhook delivery through signature
verification, persistence, merchant association, risk creation, decisioning,
outcome attribution, and audit. Its expected incremental value was **positive
(+₹500)** and the safety gate overrode it, because the payment had already
succeeded — the STOP branch behaving exactly as designed, on real data.

No execution row exists for real data, and ACT on a real payment is **not
verified**. Two separate things block it, both inside this repository:

1. **The engine cannot currently emit ACT for real traffic.** *(Superseded on
   2 September - see §8, which fixed exactly this.)*
   `candidateBuilder.ts` hardcodes `failureReason: "STATE_UNCERTAIN"` because
   `Payment` stores no structured failure reason yet. In
   `naturalRecoveryModel.ts` that reason carries a confidence of `0.35`, below
   `DEFAULT_POLICY.minConfidence` of `0.5`, so any real payment that clears the
   safety gate resolves to ESCALATE — at any amount. The code comment marks
   `contextFromPayment` as the one place that changes once the webhook captures
   a real failure reason.
2. **Nothing in the running application executes a decision.**
   `executeCommand` has no production caller — no API route, no UI control. The
   processing boundary runs association → candidate build → outcome
   attribution, and stops.

Outbound execution itself is verified separately (§3.1): `executeCommand`
created a real Test Mode Payment Link and recorded `Execution.status =
SUCCEEDED`, driven by the controlled integration test on a test-created,
`SIMULATED` decision. Proven capability, never yet reached by real traffic.

### Demo Workspace (`demo_merchant_revenue_recovery`)

| Entity | Count |
|---|---|
| Payments | 78 |
| Payment events | 53 |
| Revenue risk events | 59 (all `SIMULATED`) |
| Candidate actions | 117 |
| Decisions | 59 |
| Executions | 24 |
| Outcomes | 53 |
| Model predictions | 117 |
| Audit events | 59 `Decision` + 48 `Execution` |
| Experiments | 1 |
| Experiment measurement results | 1 — `FINAL`, `VALID_EFFECT`, version 1 |

Counts confirmed after the reset/reseed described in §3.2, which restored the
execution audit rows the unscoped test cleanup had destroyed. The seed is
deterministic, so the workspace came back with exactly the same shape.

Isolation holds in both directions: no `REAL_RAZORPAY_TEST_MODE` row belongs to
the demo merchant, and no `SIMULATED` row belongs to the Test Mode merchant.

The demo seed writes `Execution` audit events without a `merchantId`, matching
the production execution path. `activityFeedService.ts` documents this and never
queries `AuditEvent.merchantId`: it resolves decisions and executions through
the `revenueRiskEvent: { merchantId }` relation first, then reads audit rows by
entity id — so the Audit page still scopes them per merchant.

### Cross-merchant totals

Decision mix across all merchants: ACT 63, STOP 5, ESCALATE 4, WAIT 2.
Executions: 26 `PAYMENT_LINK` succeeded, 2 failed — all against synthetic data.
Payment events by type: `payment.failed` 39, `payment_link.paid` 24,
`payment.captured` 10, `order.paid` 2, `payment.authorized` 2.

### Residual test merchants

The shared database also holds several near-empty merchants left over from
earlier manual and integration runs (`Isolation Check Workspace`,
`Final Isolation Check`, `Lucide QA Test Workspace`, a `phase28-control-…`
merchant, a `demo_test_merchant_…` workspace, and one merchant named `hhhhhhh`).
They are harmless — each is scoped to its own operator and invisible to any
other merchant — but they are noise, and removing them is a deliberate
destructive action that has not been taken.

## 5. Deployment

`vercel ls` and `vercel inspect` against project
`niraj-kumar-singh-s-projects/revenue-recovery-intelligence`:

- Current production deployment: `revenue-recovery-intelligence-7d436bpcs.vercel.app`, status Ready, built from commit `aef5059` on `main` at the time of that check - production tracks `main`, so the serving deployment advances with every push (confirmed via the deployment's `meta.githubCommitSha`; `vercel inspect --json` returns a trimmed object whose `meta` is empty, so the REST API is the reliable source).
- Stable production alias: **https://revenue-recovery-intelligence.vercel.app** (HTTP 200, redirects to `/login`).
- The URL used in earlier documentation, `revenue-recovery-intelligence-qz2w9sykk.vercel.app`, is a **preview** deployment. It still responds, but it is not production and should not be cited as such.

## 6. Order of operations

The integration suite writes to the same database as the deployment. It builds
its own throwaway workspace identity, so it cannot delete the evaluator's Demo
Workspace by identity — and after the fix in §3.2 its audit cleanup can no
longer reach across workspaces either. The demo reset and seed were still run
**last**, after all tests, so the counts above are the state a reviewer will
see.

## 7. What "verified" means in this document

Stated precisely, so no row can be read as more than it is:

| Claim | Status |
|---|---|
| Razorpay Test Mode API authentication | Verified, through the application's own adapter |
| Outbound execution (Payment Link creation via `executeCommand`) | Verified — real Test Mode link created, `Execution.status = SUCCEEDED` |
| Inbound webhook lifecycle on real data | Verified through signature check, persistence, association, risk creation, decision, outcome attribution, audit, UI and reports |
| STOP branch on real Razorpay data | Verified |
| Engine able to choose ACT for a real failure | Verified by running the real engine per diagnosis (§8); not yet exercised by live traffic |
| ACT on a real payment, end to end | **Not verified** — no real payment has produced an ACT decision, and no production caller executes decisions (§4, §8) |
| Experiments and causal measurement | Verified on synthetic Demo Workspace data only |

## 8. Failure diagnosis (2 September 2026)

The §4 finding that "the engine cannot currently emit ACT for real traffic" was
addressed. `Payment` now stores Razorpay's own failure signals (`error_code`,
`error_reason`, `error_source`, `error_step`, migration
`20260901175926_payment_failure_signals`), and `failureReasonMapping.ts` maps
them onto the `RiskDiagnosis` vocabulary that `candidateBuilder.ts` feeds to the
engine.

### What the engine now does, per diagnosis

Measured by running `evaluateRecoveryDecision` itself at ₹2,500 - the real Test
Mode payment's amount - not by reading the tables:

| Razorpay signals | Diagnosis | natural / confidence | Decision | Strategy | Executable |
|---|---|---|---|---|---|
| `source=customer` | `CUSTOMER_ABANDONMENT` | 0.25 / 0.70 | ACT | PAYMENT_LINK | yes |
| `source=bank` | `OTHER_RECOVERABLE` | 0.40 / 0.55 | ACT | PAYMENT_LINK | yes |
| `source=business` | `CONFIRMED_FAILURE` | 0.05 / 0.90 | ACT | PAYMENT_LINK | yes |
| `source=gateway` | `NETWORK_DEGRADATION` | 0.55 / 0.75 | ACT | RETRY | **no** *(fixed in §9 — now PAYMENT_LINK)* |
| unrecognised code | `STATE_UNCERTAIN` | 0.35 / 0.35 | ESCALATE | none | n/a |
| no signals | `STATE_UNCERTAIN` | 0.35 / 0.35 | ESCALATE | none | n/a |

The same outcomes hold at ₹250, so they are not amount-boundary artefacts.

### What this does and does not prove

It proves the engine can choose an executable ACT for a real failure. It does
not prove ACT end to end: no real payment has arrived since the mapping
shipped, so every real `RevenueRiskEvent` in the database still carries the
`STATE_UNCERTAIN` diagnosis it was created with, and no production route or UI
control calls `executeCommand`.

### Two findings recorded rather than fixed

- **`NETWORK_DEGRADATION` selects RETRY, which the executor rejects.**
  *(Resolved - see §9.)* Razorpay has no retry-a-failed-payment API, so
  `SUPPORTED_EXECUTION_STRATEGIES` excludes it. The mismatch predates this
  work; the mapping made it reachable on real traffic for the first time.
- **`CONFIRMED_FAILURE` still reaches ACT** on a large enough amount, because
  the hand-set model gives PAYMENT_LINK a 0.03 uplift even there. That is a
  model-calibration question, not a mapping defect, and was left alone rather
  than tuned to produce a tidier table.

## 9. Executable-strategy selection (2 September 2026)

The §8 finding that the engine could select RETRY - an action Razorpay offers
no API for - was fixed.

The economics were never wrong: RETRY genuinely is the higher-value play for a
network failure. What was wrong is that the engine could SELECT something the
product cannot perform. So selection was restricted, not evaluation.

- `executableStrategies.ts` holds one source of truth for what the Execution
  Service can carry out. `executionService.ts` derives
  `SUPPORTED_EXECUTION_STRATEGIES` from it, so the two layers cannot drift
  apart. It is a separate module because the decision engine must not import
  `executionService.ts` - that pulls in Prisma and the Razorpay client, and the
  engine is a pure function that stays unit-testable without either.
- Every strategy is still evaluated and still reported in the trace's
  `expectedValues`; only `pickBestStrategy` is applied to the executable
  subset.
- The trace and the audit event carry `unexecutableBestStrategy`, so the trail
  answers "why not the cheaper option?" rather than showing only what was
  chosen.
- Where no executable strategy is allowed at all, the engine returns ESCALATE
  with reason `no_executable_strategy` rather than acting or giving up.

### Decisions after the fix

Measured the same way as §8, at ₹2,500:

| Diagnosis | Highest expected value | Selected | Executable |
|---|---|---|---|
| `CUSTOMER_ABANDONMENT` | PAYMENT_LINK | PAYMENT_LINK | yes |
| `OTHER_RECOVERABLE` | PAYMENT_LINK | PAYMENT_LINK | yes |
| `CONFIRMED_FAILURE` | PAYMENT_LINK | PAYMENT_LINK | yes |
| `NETWORK_DEGRADATION` | **RETRY (₹875)** | **PAYMENT_LINK (₹248)** | yes |
| `STATE_UNCERTAIN` | - | ESCALATE (none) | n/a |

No ACT decision can now name a strategy `executeCommand` would reject.

### Tests changed as intent, not as churn

Three tests encoded the previous behaviour and were rewritten rather than
weakened: golden scenario 2 (which asserted ACT + RETRY), the demo
`act_retry_network` scenario test, and the "known gap" block in
`decisionExecutability.test.ts`, which its own docstring said to update rather
than delete. Two demo labels that described a retry as the chosen strategy were
corrected, since they would otherwise have misdescribed the seeded data.

### Demo Workspace rebuilt

The stored demo decisions predated the fix and still showed a `RETRY_NOW`
chosen action the engine would no longer pick. The workspace was reset and
reseeded through the project's own CLI. Counts are unchanged - 78 payments, 59
risk events, 59 decisions, 24 executions, 53 outcomes, 59 `Decision` and 48
`Execution` audit events - and every chosen action is now `PAYMENT_LINK` (54),
while 58 `RETRY_NOW` candidate rows remain as evaluated-but-not-selected
alternatives. That is the intended shape: the economics stay visible, the
selection is executable.

Isolation re-checked after the rebuild: no `REAL_RAZORPAY_TEST_MODE` row in the
demo merchant, no `SIMULATED` row in the Test Mode merchant.
