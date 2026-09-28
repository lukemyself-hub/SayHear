---
status: accepted
date: 2026-07-26
---
> Current release scope: [ADR-0141](0141-g1-only-release-after-g2-retirement.md) supersedes this decision where it concerns G2/G3 or the three-stage rollout. Historical rationale follows.


# Open Loops Are Expiring Context Projections

An Open Loop is a finite-lived, versioned Context projection for one
independently closable pending state directly supported by User Evidence. The
v1 catalog is closed to `upcoming_event` and `awaited_outcome`; reminders,
goals, tasks, unfinished topics, emotions, Memory Claims, and Profile items are
outside the boundary. Multiple milestones become separate Loops only when
direct Evidence supports each one. Open Loops never notify, create task lists,
or measure completion; ADR-0043 governs in-conversation follow-up.

The model emits only a transient `OpenLoopProposal`. Deterministic code owns
eligibility, kind and non-task validation, time normalization, finite expiry,
source binding, identity, and deduplication. Direct User Evidence is the
factual root; ClaimVersion and EpisodeVersion references are optional
enrichment, and `localized_summary` is rebuildable rendering. Ambiguous or
invalid proposals fail closed without a persistent Candidate or review queue.

Expected time and expiry are distinct. V1 accepts an anchored window of at
most 31 local calendar days, stores its frozen range, precision, and IANA
timezone, and applies 7 days of grace to upcoming events or 14 days to awaited
outcomes. Without an anchor, either kind has a 14-day TTL from Evidence time.
No expiry may exceed 360 local calendar days from Evidence. Follow-up
eligibility begins 14 days before an upcoming event, at the expected start for
an awaited outcome, or at Evidence time without an anchor. Expected-time
arrival alone never changes state.

Cross-Evidence identity is deliberately conservative: reuse requires a unique
explicit match, or the same canonical Objective Claim, kind, and compatible
time. Similar text, Entities, Episodes, time, embeddings, or confidence may
retrieve candidates but cannot authorize a merge. This accepts missed Loops
to avoid false shared closure and repeated follow-up.

Terminal states are `occurred` for upcoming events, `resolved` for awaited
outcomes, and shared `canceled`, `expired`, and system-owned `retracted`.
Closure requires final or corrected User Evidence that necessarily entails the
terminal state. Silence, time arrival, uncertain or future language, and
Assistant or System content cannot close a Loop. Ambiguous closure closes none
and suppresses all reasonable targets until unique later Evidence resolves the
identity or they expire. A pre-expiry User Event wins an expiry race according
to its committed time, independent of worker order.

Expiry is enforced at read time with
`followup_eligible_from_at <= now < expires_at`; a shared recovery scanner only
materializes immutable history. Source correction or invalidation fences the
old Version immediately and either rebuilds from direct Evidence or appends
`retracted`; Full Purge deletes the whole data face. Real-world terminal states
never reopen. `expired` or `retracted` may re-form on the same logical identity
only from new, uniquely matching direct Evidence under current gates.

Current open Versions may retain rendered summary content. Superseded and
terminal summaries have a 30-day grace from leaving current open state, after
which only protected structured lineage remains; source deletion clears
affected content immediately, Forget stays fenced, and Replay fails closed
when required content is gone. The Open Loop lane itself fails closed without
blocking Conversation, Journal, or independent Memory lanes.

One User Event may atomically close an old upcoming Loop and form a new awaited
outcome, in the order: source invalidation, closure against the pre-transaction
snapshot, then formation against updated state. V1 admits at most four new
Loops per User Event and 128 current open Loops per User, including suppressed
ones. Closure and retraction free capacity first; overflow skips new proposals
deterministically and never evicts existing state.

The exact formation, lifecycle, privacy, failure, and acceptance contracts are
specified in product §14.2.4 and architecture §§7.10.2, 9.1, 12.4, 13.6,
20.4.2, and 24–29.
