# services/ml-service

Python + FastAPI. The Intelligence layer (Section 25).

Owns Models A/B/C (Section 14):
- Model A: natural recovery probability
- Model B: action-response probability
- Model C: intervention uplift

Wraps the research code in /ml (root) as a callable service. Falls back to a conservative deterministic baseline if unavailable (Section 27) - the core recovery system must keep running without it.
