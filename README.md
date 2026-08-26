# Revenue Recovery Intelligence

An AI-native economic decision layer for payment recovery, built for the
Razorpay AI Buildathon 2026 (Track 3 -- AI Revenue Recovery).

> Razorpay already knows how to recover failed payments. This determines
> whether intervention will actually create incremental revenue, chooses the
> safest high-value action, executes bounded recovery workflows through
> Razorpay, and proves the incremental impact.

## Status

Repository skeleton and domain model frozen. See docs/domain-model.md for
the schema and docs/decisions/ for ADRs as they are written.

## Structure

- apps/web -- Next.js frontend
- apps/api -- Node/TypeScript backend, owns webhook ingestion
- services/decision-engine -- the Policy layer (economic and safety decisioning)
- services/ml-service -- the Intelligence layer (Python/FastAPI, Models A/B/C)
- services/event-worker -- async event processing
- services/simulator -- deployable wrapper around the research simulator
- packages/* -- shared domain types, Razorpay adapter, validation, etc.
- prisma/schema.prisma -- the domain model (see docs/domain-model.md)
- experiments/, ml/, simulator/ (root) -- research workspaces, not deployed services

## Setup

1. Copy .env.example to .env and fill in Razorpay Test Mode credentials.
2. docker-compose up -d for Postgres and Redis.
3. pnpm install
4. pnpm db:migrate
5. pnpm dev

## What is real vs simulated

See Section 18 of the master specification. This table gets filled in as
components are built -- do not mark anything real here until it is.

| Component | Status |
|---|---|
| Payment webhook ingestion | Planned |
| Webhook signature verification | Planned |
| Payment Link creation | Planned |
| Payment Link confirmation | Planned |
| Revenue simulator | Planned |
| 20K-event experiment | Planned |
| ML models | Planned |
| Network intelligence | Planned |
| LLM explanation | Planned |
