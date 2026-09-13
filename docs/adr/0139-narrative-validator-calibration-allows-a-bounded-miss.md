---
status: accepted
date: 2026-09-12
---

# Narrative validator calibration allows a bounded miss

The first `narrative.validate` release calibration still requires Luke to
adjudicate all eighteen fixed cases. Calibration recall may miss at most ten
percent of the set, rounded down: one rejected case out of eighteen is within
budget, while two rejected cases block release. Precision remains a separate
zero-tolerance gate: the fixed precision probes must produce no false blocks.
Confirmed deterministic hard-gate failures also remain zero-tolerance, and a
calibration miss is recorded in the ledger and added to regression coverage.

This replaces ADR-0125's original rule that any calibration miss blocks the
release. The bounded budget reflects the observed limits of semantic
calibration without allowing a model that over-blocks valid narratives or
letting experience evidence compensate for deterministic correctness.
