# Verification Log

What was actually run to finalize this project, when, and what it produced.
Every number here came from a command in this repository or a query against the
database the deployment uses. Nothing in this file is estimated.

**Date:** 1 September 2026
**Commit:** `a9f613d`
**Branch:** `main`

This log was written in two passes on the same day. The first pass ran against
`352418b`; a second pass followed after the Razorpay Test Mode credentials were
replaced and two defects were fixed. Where the first pass's finding was later
superseded, the entry says so rather than being quietly deleted.

## 1. Static checks

| Command | Result |
|---|---|
| `pnpm lint` | clean |
| `pnpm typecheck` | clean (forced, uncached) |
| `pnpm build` | clean — Next.js 16.3.3, Turbopack, all routes compiled |
| `prisma validate` | schema valid |
| `prisma migrate status` | 11 migrations, database schema up to date |

`turbo run build typecheck` in **parallel** fails with `TS2307: Cannot find
module './routes.js'` — the two tasks race on `.next/types`. Run them
sequentially. This is a task-ordering artefact, not a code defect.

One local-only obstacle was removed first: an untracked scratch file,
`apps/web/src/lib/demo/__counts.ts`, left over from an earlier debugging
session, failed type checking (`TS2322` on an `ExperimentAssignment.groupBy`
field name). It was never committed, so it never affected deployments; it was
moved out of the working tree rather than committed or ignored.

## 2. Unit tests

`pnpm test` (in `apps/web`) — **61 files, 640 tests, all passing**, ~4s, no
database access.

## 3. Integration tests

`pnpm test:integration` (in `apps/web`) — **20 files, 143 tests**, ~7-8 minutes
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

1. **The engine cannot currently emit ACT for real traffic.**
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

- Current production deployment: `revenue-recovery-intelligence-b6yqlknhe.vercel.app`, status Ready, built from commit `a9f613d` on `main` (confirmed via the deployment's `meta.githubCommitSha`; `vercel inspect --json` returns a trimmed object whose `meta` is empty, so the REST API is the reliable source).
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
| ACT on a real payment, end to end | **Not verified** — the engine cannot emit ACT for real traffic today, and no production caller executes decisions (§4) |
| Experiments and causal measurement | Verified on synthetic Demo Workspace data only |
