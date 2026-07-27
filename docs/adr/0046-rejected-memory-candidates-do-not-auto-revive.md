---
status: accepted
date: 2026-07-26
---

# Rejected Memory Candidates Do Not Auto-Revive

A MemoryCandidate rejected by long-term Memory policy is terminal for that
recorded disposition. A later Predicate Registry release, repeated extraction,
elapsed time, higher model confidence, Consolidation, or repair cannot mutate
it to accepted, promote it into an active Claim, or recreate the same proposal
from the same Evidence to bypass the rejection.

Rejection does not declare the underlying Evidence false and does not delete
the source Conversation, Journal, or EvidenceItem. Any future reconsideration
must be an explicit, versioned operation that preserves the original rejection
lineage; ADR-0052 additionally permits a new successor only when new User
Evidence materially changes admission conditions. Ordinary Registry evolution
is not authorization to turn previously rejected private material into
long-term Memory.
