---
status: accepted
date: 2026-07-26
---

# Restarted relationships reuse the logical Claim

When the same Entity pair enters the same Relationship Predicate again after
it ended, SayHear reuses the existing logical Memory Claim and creates a new
ClaimVersion with the new temporal interval. Reconciliation after a breakup or
becoming colleagues again after changing jobs therefore does not create a
relationship occurrence ID or duplicate Claim. Append-only ClaimVersions
preserve every current and ended interval, while Resolver Hints read only the
current version. Whole-Claim Forget covers the relationship's long-term
Memory, and period-scoped Forget is not built in the current scope. This keeps
canonical identity as Entity pair plus Predicate and avoids a difficult,
low-value distinction between a resumed relationship and a new occurrence.
