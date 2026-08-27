# Application Authentication & Merchant Authorization (Phase 25 Steps 2A/2B)

This document explains the operator authentication infrastructure (Step
2A) and the merchant authorization layer built on top of it (Step 2B).
Together they answer two deliberately separate questions:

```
authenticateOperator() -> "who is the authenticated operator?"
resolveMerchantAccess() -> "which merchant may they access?"
```

---

## What this is NOT

This is **application operator authentication** — the login for a human
operating this product's own dashboard/API. It is completely unrelated to:

- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` —
  server-side infrastructure secrets this product uses to call Razorpay's
  API on its own behalf. An operator never sees or enters these anywhere.
- `DATABASE_URL` / `DIRECT_URL` — server-side database connection secrets.

No login screen in this product will ever ask for a Razorpay credential.

## Mechanism

Self-hosted, database-backed session authentication. No external auth
provider (Auth.js/Clerk/Supabase Auth/etc.) and no new npm dependency —
password hashing and session-token generation both use Node's built-in
`node:crypto` module only.

**Why self-hosted instead of a library:** this codebase's existing
philosophy (see `ENGINEERING_PRINCIPLES.md`, and the pattern used
throughout `apps/web/src/lib/*`) favors small, fully-inspectable,
dependency-minimal modules over large SDKs, especially for
security-critical code in a fintech product where every line should be
auditable without trusting a third party's defaults. A credentials-based
login for a small, deliberately-provisioned set of operators does not need
OAuth providers, social login, or a multi-tenant auth SaaS — the
complexity such a library brings has no measurable justification here.

**Why a database-backed session instead of a stateless JWT/signed cookie:**
a stateless cookie cannot be truly revoked before its expiry without its
own server-side deny-list — which is equivalent persisted state anyway.
Real, immediate logout/revocation (e.g. a compromised operator device) is a
genuine security requirement for a fintech recovery product, not
speculative engineering.

### Password storage

`apps/web/src/lib/auth/password.ts`. Passwords are hashed with
`crypto.scryptSync` (N=16384, r=8, p=1, 64-byte key — Node's own documented
example parameters), each with a random 16-byte salt, encoded as
`scrypt:N:r:p:saltHex:hashHex` so cost parameters can be upgraded later
without breaking existing hashes. Verification uses `timingSafeEqual`.
Minimum password length: 8 characters (a floor, not a full strength
policy — see Limitations).

### Session tokens

`apps/web/src/lib/auth/sessionToken.ts`. A session token is 256 bits of
`crypto.randomBytes`, base64url-encoded. Only its SHA-256 hash is ever
persisted (`OperatorSession.tokenHash`) — the raw token exists only in the
HttpOnly cookie sent to the browser, so a stolen database row alone can
never be replayed as a valid session.

## Merchant model: single-merchant operator (Phase 25 Step 2B)

**Decision (explicitly made, not invented):** each `Operator` belongs to
exactly **one** `Merchant` (`Operator.merchantId`, a required foreign key).
This matches a standard B2B SaaS shape — a merchant's own staff log in and
see only their own recovery data. A multi-merchant-per-operator model
(join table, optionally with per-merchant roles) was evaluated and
deliberately not chosen, for simplicity and the strongest possible
isolation guarantee; it remains a documented option if a future need
arises (see Limitations).

`Operator.email` stays **globally** unique (not per-merchant) because
login is a single email+password form with no merchant selector —
`verifyOperatorCredentials` looks up by email alone, and the merchant is
discovered *from* the matched operator row, never supplied by the caller.

### Database schema

- **`Operator`** (`operators`): `id`, `merchantId` (required FK →
  `Merchant`, `onDelete: Cascade`), `email` (unique), `passwordHash`,
  timestamps.
- **`OperatorSession`** (`operator_sessions`): unchanged from Step 2A —
  `id`, `operatorId`, `tokenHash` (unique), `createdAt`, `expiresAt`,
  `revokedAt` (nullable).

Migrations: `20260827180000_operator_authentication` (Step 2A, purely
additive) and `20260827190000_operator_merchant_scope` (Step 2B, adds the
required `merchantId` column + FK + index to the already-empty `operators`
table — no backfill was needed or performed). No existing table was
touched by either.

## Session model

- **Lifetime:** 12 hours, fixed (not sliding/renewed) —
  `SESSION_TTL_MS` in `sessionToken.ts`.
- **Storage:** server-side, in `OperatorSession`. The client only holds the
  opaque token.
- **Cookie:** `operator_session`, `HttpOnly`, `SameSite=Lax`, `Secure` in
  production only (allows local `http://localhost` development), `Path=/`,
  expiry matching the session's `expiresAt`.
- **Rotation:** not implemented (see Limitations).
- **Logout/revocation:** `POST /api/auth/logout` marks the session
  `revokedAt` in the database and clears the cookie. Idempotent. Deleting a
  Merchant cascades to delete its Operators, which cascades to delete
  their Sessions — verified against a real database.
- **Server-side validation:** every read of "who is authenticated" re-reads
  the database; client-held state is never trusted as authoritative.

## The two-stage authorization boundary

```
authenticateOperator() -> { operator: { id, email }, sessionId } | null
resolveMerchantAccess(operatorId) -> { merchantId } | null
authorizeMerchantAccess(operatorId, requestedMerchantId) -> { authorized: true, merchantId } | { authorized: false }
```

`apps/web/src/lib/auth/authenticateOperator.ts` answers only "who is
authenticated" (Step 2A, unchanged). `apps/web/src/lib/auth/merchantAccess.ts`
(Step 2B) answers only "which merchant" — a genuinely separate function
with its own database read, deliberately never folded into
`authenticateOperator`'s return type. This means a future change to the
merchant model (e.g. multi-merchant operators) only has to change
`merchantAccess.ts`; every existing authentication caller is unaffected.

Every future domain API (Recovery, Experiments, Audit, etc.) is expected
to call through this exact chain:

```
authenticateOperator() -> resolveMerchantAccess()/authorizeMerchantAccess() -> merchant-scoped query
```

`authorizeMerchantAccess` exists specifically for routes that receive an
explicit `merchantId` from client input (e.g. a path param) and must
verify it against the operator's own merchant rather than trusting the
caller-supplied value — this is the actual mechanism that prevents an
IDOR-style cross-merchant data leak. It was proven against two real,
distinct `Merchant` rows in a real-database integration test.

## CSRF stance

No separate CSRF token scheme was added. `SameSite=Lax` on the session
cookie already blocks it from being sent on a cross-site top-level
POST/fetch — the classic CSRF vector — and every state-changing endpoint
here (`/api/auth/login`, `/api/auth/logout`) is invoked via same-origin
JSON `fetch`, never a classic auto-submitting cross-site HTML form target.

## Endpoints

| Method | Path | Purpose | Auth required |
|---|---|---|---|
| POST | `/api/auth/login` | Verify email+password, create a session, set the cookie | No |
| POST | `/api/auth/logout` | Revoke the current session, clear the cookie | No (idempotent even with no session) |
| GET | `/api/auth/session` | Return the authenticated operator's identity **and their merchantId**, or 401 | Yes |

There is **no public registration endpoint** — see Limitations.

## Environment requirements

**None.** No new environment variable was introduced by either step —
`.env.example` is unchanged.

## Local development setup

1. Run migrations as usual (`prisma migrate deploy`) — already applied.
2. Create a merchant if one doesn't exist (`prisma.merchant.create`), then
   an operator scoped to it: `createOperator(email, password, merchantId)`
   from `apps/web/src/lib/auth/authService.ts`. There is intentionally no
   HTTP endpoint for this — see Limitations.
3. `POST /api/auth/login` with `{ "email": ..., "password": ... }` to
   obtain a session cookie; `GET /api/auth/session` to confirm identity and
   merchant; `POST /api/auth/logout` to end it.

## Known limitations

- **No public/self-service operator provisioning.** By design — an open
  registration endpoint on a fintech recovery dashboard would let any
  anonymous caller grant themselves access. `createOperator()` exists only
  as an internal function; a controlled provisioning flow (admin-only
  endpoint, CLI, or seed process) is unbuilt.
- **No brute-force/rate limiting on login attempts.** No rate-limiting
  infrastructure exists yet in this codebase.
- **No session rotation on privilege change or periodic renewal.**
- **No account lockout, password reset, or MFA.**
- **No login UI.** Only the API boundary was built.
- **Single-merchant-per-operator only.** An operator who genuinely needs
  access to more than one merchant (e.g. an agency) is not supported; this
  would require a schema change (a join table) evaluated and deliberately
  deferred in Step 2B, not an oversight.
- **No operator roles.** Every operator has identical (full, own-merchant)
  access; no viewer/admin distinction exists. Not needed by anything built
  so far.
- **`Experiment`/`ExperimentAssignment`/`ExperimentMeasurementResult` still
  have no merchant boundary at all** (the Phase 25 Step 1 audit's finding).
  `resolveMerchantAccess`/`authorizeMerchantAccess` exist and work
  correctly for every merchant-scoped table, but cannot yet be used to
  scope an Experiment query — that gap is explicitly a separate, later
  step ("Experiment isolation") in the approved plan, not solved here.

## Regression scope

Confirmed unchanged (byte-identical): Razorpay webhook route, signature
verification, webhook idempotency, payment association, recovery decision
engine, execution service, outcome attribution, experiment
assignment/measurement. Full unit and integration suites re-run after both
steps with no new failures (see the Phase 25 Step 2A/2B implementation
reports for exact numbers).
