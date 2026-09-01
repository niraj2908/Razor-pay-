# Verification Log

What was actually run to finalize this project, when, and what it produced.
Every number here came from a command in this repository or a query against the
database the deployment uses. Nothing in this file is estimated.

**Date:** 1 September 2026
**Commit:** `352418b` (`feat(razorpay): distinguish integration status from workspace binding and lifecycle evidence`)
**Branch:** `main`

## 1. Static checks

| Command | Result |
|---|---|
| `pnpm typecheck` | clean (forced, uncached) |
| `pnpm build` | clean — Next.js 16.3.3, Turbopack, all routes compiled |

One local-only obstacle was removed first: an untracked scratch file,
`apps/web/src/lib/demo/__counts.ts`, left over from an earlier debugging
session, failed type checking (`TS2322` on an `ExperimentAssignment.groupBy`
field name). It was never committed, so it never affected deployments; it was
moved out of the working tree rather than committed or ignored.

## 2. Unit tests

`pnpm test` (in `apps/web`) — **61 files, 640 tests, all passing**, ~4s, no
database access.

## 3. Integration tests

`pnpm test:integration` (in `apps/web`) — **20 files, 143 tests, 142 passing,
1 failing**, ~8 minutes against the live Postgres pooler.

The failure is in `src/lib/recovery/executionService.integration.test.ts`:

```
expected 'failed' to be 'succeeded'
```

That test drives `executeCommand` → Razorpay adapter → Razorpay Test Mode to
create a real ₹1 Payment Link. Investigation showed the cause is credentials,
not code:

```
GET https://api.razorpay.com/v1/payment_links?count=1
→ 401 {"error":{"code":"BAD_REQUEST_ERROR","description":"Authentication failed"}}
```

The key id in `.env` (`rzp_test_TWk…`) is rejected by Razorpay on every
endpoint tried. A second, older key pair present in `.env.local`
(`rzp_test_TUH…`) still authenticates and lists existing payment links, but it
belongs to the earlier Test Mode account — the one whose 30-payment-link quota
was exhausted — and is not the account bound to `RAZORPAY_MERCHANT_ID`.

Note that Prisma loads `.env` and ignores `.env.local`, so `.env` is what the
application and the test suite actually use. Restoring outbound verification
requires a valid secret for the bound account in `.env`.

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

So the real-data chain is verified from webhook delivery through signature
verification, persistence, merchant association, risk creation, decisioning,
outcome attribution, and audit — and **stops there**. No execution row exists
for real data, which is consistent with a STOP decision and with the fact that
`executeCommand` has no production caller: no API route and no UI control
invokes it. ACT execution against real Razorpay is therefore **not verified**.

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
| Audit events | 59 |
| Experiments | 1 |
| Experiment measurement results | 1 — `FINAL`, `VALID_EFFECT`, version 1 |

Isolation holds in both directions: no `REAL_RAZORPAY_TEST_MODE` row belongs to
the demo merchant, and no `SIMULATED` row belongs to the Test Mode merchant.

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

- Current production deployment: `revenue-recovery-intelligence-lmkpxlzig.vercel.app`, status Ready, created 2026-09-01 17:10 IST — 16 seconds after commit `352418b` was authored.
- Stable production alias: **https://revenue-recovery-intelligence.vercel.app** (HTTP 200, redirects to `/login`).
- The URL used in earlier documentation, `revenue-recovery-intelligence-qz2w9sykk.vercel.app`, is a **preview** deployment. It still responds, but it is not production and should not be cited as such.

## 6. Order of operations

The integration suite writes to the same database as the deployment. It builds
its own throwaway workspace identity, so it cannot delete the evaluator's Demo
Workspace — but the demo seed was still run **last**, after all tests, so the
counts above are the state a reviewer will see.
