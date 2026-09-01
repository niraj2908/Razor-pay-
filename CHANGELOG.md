# Changelog

## [Unreleased]
### Added
- Repository skeleton matching Section 23 of the master specification.
- Domain model (prisma/schema.prisma) implementing the entities from Section 24.
- `docs/verification.md` — a dated record of the checks, test runs, database
  queries, and deployment inspection behind the claims in the README.

### Changed
- README rewritten as the project's finished documentation: live deployment
  URL, verified status, real-vs-simulated table, Razorpay lifecycle evidence,
  Demo Workspace contents, reproduction steps, and known limitations.
- JUDGING_MATRIX now cites repository-relative code, tests, and database
  evidence per criterion, and states its open gaps explicitly.
- `apps/web/README.md` replaced the `create-next-app` boilerplate with the
  application's actual layout and commands.

### Known gaps
- ACT execution has no production trigger, and outbound Razorpay Test Mode
  calls currently fail authentication with the configured key.
- Recovery probabilities remain hand-set cold-start baselines.
