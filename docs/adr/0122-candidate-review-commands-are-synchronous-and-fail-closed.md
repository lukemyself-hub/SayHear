---
status: accepted
date: 2026-09-04
---

# Candidate Review Commands Are Synchronous and Fail Closed at Every Boundary

The Candidate Review Module's dispositions — `map_existing`, `reject`,
`approve_for_registry_change` — and the Predicate Registry Governance
Module's Proposal lifecycle commands — `cancel` and proposal-level explicit
reconsideration — are synchronous typed operator commands over conditional
database updates, not durable workflows. A disposition is a single-row
compare-and-set: a losing concurrent submitter receives `already_disposed`,
and re-submitting a committed disposition reads it back idempotently. A human
disposition is valid only if `decided_at <= review_due_at`, the exact
symmetry of ADR-0050's `published_at <= registry_release_due_at` rule. A
disposition committed after the deadline fails closed with
`review_deadline_passed` and the candidate goes stale regardless of sweeper
timing, so no outcome depends on which asynchronous task ran first.

Canceling an awaiting-release Proposal immediately and idempotently moves
its linked `awaiting_registry_release` candidates to stale with reason
`registry_release_canceled` and `terminal_effective_at` equal to the cancel
commit time, while the Proposal persists as `canceled`. Letting candidates
ride out the 90 days or re-queueing them with a fresh 30-day review deadline
were both rejected: the first only delays hidden Memory, the second reopens
the review queue after the human withdrew the release promise. Cancel is not
a product-value judgment; the concept can earn a new Proposal through normal
review. Explicit reconsideration exists only at the Proposal level in v1 — a
superseding ProposalVersion with the old rejection immutable — while
candidate-level successors come only from the deterministic
Materially-New-Evidence evaluator (ADR-0052). The `explicit_reconsideration`
successor trigger stays reserved in v1 so that no human command can bypass a
terminal fence.

Proposal identity is an opaque row with append-only, immutable versions, and
two Proposals are never auto-matched by text similarity: associating a
candidate with an existing awaiting Proposal is a reviewer selection made at
approve time, and later model `matched_governance` citations are validated
against the current version only. The no-user-content guarantee on Proposals
is structural rather than validated after the fact: the Proposal schema has
no field capable of carrying subject `user_id`, Evidence references, typed
values, Entity references, or verbatim user text; the concept label is
rewritten by the reviewer, never copied from the model-derived
`proposed_concept`; and the Governance Module rejects any payload that
smuggles private content.

Registry release stays manual transcription: the developer authors the
TS/YAML entry, mapping tests, and migration from the Proposal, which is a
spec for humans rather than machine input. The release migration marks the
target ProposalVersion published — with `published_at` taken from the
migration's own commit moment, in the same transaction as the registry table
sync — so the 90-day boundary test is anchored to the release transaction
itself, not to any asynchronous task. Post-release reprocessing runs as
reconciliation: the publication transaction emits an outbox event, a handler
inserts idempotent per-candidate remap commands keyed by
`candidate-remap/<candidate-id>/<registry-version>/<policy-version>`, and
the recovery scan backstops missed events; the 30/90-day deadline sweeps
remain in the existing memory sweeper. Queue browsing requires the review
capability but no step-up — a deliberate exception to the
sensitive-derived-data access rule, because step-up-per-glance would tax the
30-day review deadline — while full Evidence inspection and every command
keep step-up and access audit.
