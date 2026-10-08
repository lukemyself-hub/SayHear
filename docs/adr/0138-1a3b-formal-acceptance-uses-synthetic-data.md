---
status: accepted
date: 2026-09-07
---
> Revised by [ADR-0148](0148-deployment-identity-config-authorization-and-acceptance-are-separate.md) where it concerns running the complete drill for every exact release manifest; synthetic-only acceptance and the change-triggered re-run rule stay in force.

# 1A.3b formal acceptance uses synthetic data

Formal 1A.3b model comparison, behavior evaluation, fault injection, and
acceptance evidence use only fixed synthetic test data. Real Internal Owner
data may be observed through the normal product path after rollout, but it is
not a release or final-acceptance gate and is never automatically shadowed or
copied into evaluation artifacts. This keeps the evidence reproducible and
avoids pulling 1A.4 private-Replay infrastructure into 1A.3b.

For each exact release manifest, Full Purge acceptance runs one complete
seeded-canary purge across every registered `delete` and `content_purge`
surface, one restore drill in which the backup snapshot predates the purge,
and both controlled race orders for every in-flight 1A.3b artifact, Workflow,
and Provider result. Changing a Purge Surface Registry entry, Schema,
clear/verify handler, or external integration invalidates that evidence and
requires the complete drill again. Repeating an unchanged deterministic run
an arbitrary number of times is not additional acceptance evidence.
