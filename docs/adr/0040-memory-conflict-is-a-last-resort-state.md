---
status: accepted
date: 2026-07-26
---

# Memory Conflict Is a Last-Resort State

When new User Evidence disagrees with a current Memory Claim, SayHear first
applies the Predicate Registry's temporal semantics, normalized scope, and
value cardinality. An explicit time or state change creates a new confirmed
ClaimVersion while preserving the old version as history; an explicit
correction supersedes the erroneous version; values that the Registry permits
to coexist remain separate. Neither recency nor model confidence selects a
winner by itself.

Only mutually exclusive values for the same Predicate, scope, and effective
time whose intent cannot be resolved from Evidence create a
`contested + review_due` ClaimVersion. That Claim immediately leaves Recall,
Profile, Embedding, and cross-day narrative use. SayHear asks at most one
natural clarification only when the conflict materially affects the current
understanding or response; otherwise it waits for new User Evidence. Any later
resolution creates another immutable ClaimVersion. This preserves real life
changes without silently accepting contradictions or turning memory cleanup
into an interrogation.
