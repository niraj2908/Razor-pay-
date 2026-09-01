# apps/web

The deployed application: Next.js 16 (App Router, Turbopack) serving both the
operator UI and every server route — webhook ingestion, decisioning, reporting,
and the assistant. Everything that runs in production lives here; the other
workspace folders are placeholders (see the repository README).

## Layout

- `src/app/(app)/` — authenticated operator surfaces: Overview, Recovery Queue,
  Decision Detail, Experiments, Reports, Audit, Assistant, Security & Policies.
- `src/app/api/` — route handlers, including `api/webhooks/razorpay` (the only
  unauthenticated route; it authenticates by HMAC signature instead).
- `src/lib/recovery/` — decision engine, policy, safety gate, execution service.
- `src/lib/experiments/` — assignment and causal measurement.
- `src/lib/razorpay/` — signature verification, REST client, connection status,
  lifecycle verification.
- `src/lib/demo/` — deterministic Demo Workspace seed/reset.

## Commands

```bash
pnpm dev               # local dev server
pnpm test              # unit tests (no database)
pnpm test:integration  # integration tests (requires DATABASE_URL)
pnpm typecheck
pnpm build
pnpm db:seed:demo      # populate the Demo Workspace
pnpm db:reset:demo     # remove the Demo Workspace
```

`pnpm test:integration` writes to the database named by `DATABASE_URL` and
resets the Demo Workspace as part of its cleanup, so run the demo seed after
the suite, never before it.
