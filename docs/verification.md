# Verification Log

What was actually run to finalize this project, when, and what it produced.
Every number here came from a command in this repository or a query against the
database the deployment uses. Nothing in this file is estimated.

**Date:** 1-2 September 2026
**Commits:** passes verified at `352418b`, `a9f613d`, `aef5059`, and the executable-strategy work in §9
**Branch:** `main`

This log was written in six passes. The first ran against `352418b`; a second
followed after the Razorpay Test Mode credentials were replaced and two defects
were fixed; a third (§8) records the failure-diagnosis work that made ACT
reachable for real traffic; a fourth (§9) records the executable-strategy fix
that followed from it; a fifth (§10) records the operator execution trigger; a sixth (§11) records the
real end-to-end ACT execution that closed the last open gap. Where an earlier pass's finding was later
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

`pnpm test` (in `apps/web`) — **64 files, 686 tests, all passing**, ~5s, no
database access.

## 3. Integration tests

`pnpm test:integration` (in `apps/web`) — **21 files, 150 tests**, ~7-8 minutes
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
2. **Nothing in the running application executes a decision.** *(Superseded on
   2 September — see §10, which added an operator-triggered endpoint. The
   webhook processing path still stops at outcome attribution.)*
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

These are **database-wide incidental sums** across every merchant in the shared
instance — the Demo Workspace, the real Test Mode merchant, and whatever
throwaway merchants an integration run happened to leave behind. They are *not*
the Demo Workspace metrics a judge sees: those are the per-merchant figures in
the table above, and no screen in the product displays these totals at all.
They move whenever the demo is reseeded or a test suite cleans up after itself,
so treat them as a snapshot rather than a fixture.

Re-verified 2026-09-02:

Decision mix across all merchants: ACT 56, STOP 4, WAIT 1, ESCALATE 2.
Executions: 24 `PAYMENT_LINK` succeeded, 1 failed.
Payment events by type: `payment.failed` 37, `payment_link.paid` 22,
`payment.captured` 10, `order.paid` 2, `payment.authorized` 2.

(The previous snapshot recorded on 1 September read ACT 63 / STOP 5 /
ESCALATE 4 / WAIT 2, with 26 executions succeeded and 2 failed. The difference
is the demo reset/reseed in §9 plus integration-test merchants removed by their
own cleanup — not a data inconsistency.)

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
| Engine able to choose ACT for a real failure | Verified by running the real engine per diagnosis (§8), and exercised on real live traffic (§11) |
| Operator execution trigger | Implemented, integration-tested (§10), and exercised on a real ACT decision (§11) |
| ACT on a real payment, end to end | **Verified** 2026-09-01 (§11) — real `payment.failed` → ACT → operator approval → real Razorpay Payment Link |
| Revenue actually recovered by that execution | **Not verified** — the created link is unpaid; outcome `PENDING`, attribution null (§11) |
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

It proves the engine can choose an executable ACT for a real failure. At the
time of this pass it did not yet prove ACT end to end: no real payment had
arrived since the mapping shipped, so every real `RevenueRiskEvent` still
carried the `STATE_UNCERTAIN` diagnosis it was created with. *(Both gaps closed
later the same day — the missing production caller in §10, and a real
`payment.failed` diagnosed `NETWORK_DEGRADATION` and executed by an operator in
§11.)*

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

## 10. Operator execution trigger (2 September 2026)

`executeCommand` now has a production caller:
`POST /api/recovery/decisions/[decisionId]/execute`, backed by
`decisionExecutionService.ts` and reached from an Execute control that
Decision Detail renders **only** for an ACT decision with no execution yet.

Execution is **operator-approved, never autonomous**. The webhook processing
path is unchanged and still stops at outcome attribution; nothing a webhook
delivers can move money on its own.

### What the endpoint does and cannot do

- Loads the decision scoped by `revenueRiskEvent: { merchantId }`, with the
  merchant taken from the operator's session. The route accepts no merchant
  parameter and no request body.
- Cannot re-decide. A WAIT, STOP or ESCALATE decision is refused
  (`decision_not_act`), and the strategy is the one already stored on the
  decision - a caller cannot substitute another.
- Leaves every existing gate in force: the 30-minute decision-staleness window
  (`MAX_DECISION_AGE_MS`, unchanged), the supported-strategy list, and the
  experiment CONTROL-arm block inside `executeCommand`.
- Collapses duplicates on the unique `Execution.decisionId`: a second trigger
  returns the existing execution and makes no second Razorpay call.
- Records `execution.requested` and then `execution.succeeded` /
  `execution.failed` / `execution.skipped`.
- Never disguises a failure as success: a definitive Razorpay failure is 502, a
  refusal is 409 with its reason, and an **ambiguous** result (timeout or
  network failure, where the Razorpay call may or may not have landed) is 202,
  which the UI presents as "reload and review" rather than inviting a blind
  retry.

### Tests

15 route unit tests: authentication, merchant derived from the session only,
404 for both nonexistent and foreign-merchant decisions, every result-status
mapping, path-traversal id rejection, and a sanitized 500 carrying no stack
trace.

5 integration tests against the real database with the Razorpay client mocked -
a real Test Mode Payment Link is already proven by
`executionService.integration.test.ts` (§3.1), and re-proving it here would
consume account quota for nothing:

- another merchant's ACT decision returns `not_found`, with no Razorpay call and
  no execution row created;
- a non-ACT decision and an ACT decision with no chosen action are both refused
  before any call;
- a successful execution records the `Execution` row and both audit events;
- a second trigger on the same decision produces exactly one execution row and
  exactly one Razorpay call.

### Evidence status after this pass

| Claim | Status |
|---|---|
| Razorpay Test Mode API authentication | **Verified** |
| Real webhook lifecycle (delivery → signature → persistence → association → risk → decision → outcome → audit) | **Verified** |
| Real service-layer Payment Link execution | **Verified** |
| Operator execution trigger | **Implemented and integration-tested** |
| Real failing Test Mode payment → ACT → operator click → real Payment Link | **VERIFIED** 2026-09-01 — see §11 |

*(That gap was closed the same day - see §11.)* It required a genuine failing
Test Mode checkout whose failure signals map to an ACT decision, executed by a
person, which is exactly what happened.

## 11. Real end-to-end ACT execution (2026-09-01)

The last open gap is closed. A genuine Razorpay Test Mode failure produced an
ACT decision that an authenticated operator executed, creating a real Razorpay
Payment Link. Every value below was read from the database or from Razorpay's
API after the fact; none is asserted.

### The chain

| Stage | Evidence |
|---|---|
| Razorpay payment | `pay_TWuddosezaG8S2` — ₹100, card, **FAILED** |
| Failure signals | `error_code BAD_REQUEST_ERROR`, `error_reason payment_failed`, `error_source gateway`, `error_step payment_authorization` |
| Webhook | `payment.failed`, event id `TWudu4AHIXqCGQ`, ingested **20:57:51.973Z** |
| RevenueRiskEvent | `f894e110-2d96-4ff1-94a2-516e06946c54`, `dataSource REAL_RAZORPAY_TEST_MODE` |
| Diagnosis | `NETWORK_DEGRADATION`, mapped from `error_source: gateway` |
| Model | natural recovery **0.55**, confidence **0.75** (policy minimum 0.5) |
| Decision | **ACT** `cmtj5fqhj000fbt15jwg9q6hz`, decided **20:58:07.447Z**, `policy-v1` / `baseline-v1` |
| Chosen action | **PAYMENT_LINK**, expected incremental value **₹8** |
| Strategy not taken | RETRY priced higher (**₹35**) but is not performable — recorded as `unexecutableBestStrategy`, never selected |
| Operator approval | Execute clicked by an authenticated operator on the Test Mode merchant, **21:15:11.796Z** |
| Razorpay Payment Link | **`plink_TWuwKdqiR5pn5g`**, created ~**21:15:16Z**, `reference_id` = the decision id |
| Execution | `cmtj61ovo0005z9tu731cetsc`, **SUCCEEDED**, completed **21:15:17.156Z** |
| Audit trail | `execution.requested` 21:15:12.850Z · `execution.started` 21:15:14.943Z · `execution.succeeded` 21:15:18.203Z |

Ingestion to decision took 16 seconds. Decision to executed Payment Link took
about 5 seconds once the operator approved.

### Integrity checks after execution

- Exactly **1** execution row for the decision, and exactly **1** distinct
  Razorpay reference - no duplicate execution, no duplicate link.
- The decision is **immutable**: still ACT, same `decidedAt`, same chosen
  action, same expected incremental value, and exactly one `decision.act` audit
  event. Executing wrote nothing back onto it.
- Outcome remains **`PENDING`**, `attributionStatus` null, `recoveredAmount`
  null, `RevenueRiskEvent.resolvedAt` null.
- Isolation intact: this is `REAL_RAZORPAY_TEST_MODE` data on
  `razorpay_test_mode_merchant`; the Demo Workspace holds no real rows and the
  Test Mode merchant holds no synthetic ones.

### What this does and does not prove

**Verified:** real failed-payment ingestion, and real operator-approved recovery
execution against Razorpay.

**Not verified:** that this execution recovered revenue. The Payment Link is
unpaid (`amount_paid` 0). Executing a recovery is not the same as recovering
revenue, and the system deliberately claims nothing until a qualifying outcome
arrives - at which point attribution must still decide whether the payment was
incremental or would have happened anyway.

The three real lifecycles now on record are one STOP (safety gate on an
already-succeeded payment), one STOP on a successful wallet payment, and this
ACT. Every model number behind them is a hand-set baseline, advisory only - not
a trained model - and the Demo Workspace remains separately labelled synthetic.

This prototype holds no RBI authorisation, no PCI-DSS certification, and no DPDP
compliance attestation.
