---
status: accepted
date: 2026-07-26
---

# Predicate Review Candidates Expire After Thirty Days

A Predicate Review Eligible MemoryCandidate may remain in
`needs_predicate_review` for at most 30 days after entering that state. If no
authorized human disposition is recorded by the deadline, the Candidate
deterministically becomes `stale` and can no longer participate in mapping,
admission, Claim promotion, or automatic retry after a later Registry release.

The deadline prevents the internal review queue from becoming indefinite
hidden Memory. ADR-0051 separately limits terminal Candidate derived content
to a seven-day troubleshooting grace. ADR-0052 allows a separate successor
only when new Evidence materially changes admission conditions.
