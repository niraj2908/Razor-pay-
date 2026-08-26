# Contributing

Git strategy, frozen from Master Specification Section 36.

- Small, meaningful commits -- not one giant final-project commit.
- Commit message style: feat(scope): description, e.g.
  feat(simulator): add revenue risk event generator
- One branch per phase/workstream (the parallel tracks defined in Section 52).
- Tests before merge -- no broken main branch (Section 35).
- Significant decisions get an ADR in docs/decisions/ (Section 37): context,
  decision, alternatives, consequences.
