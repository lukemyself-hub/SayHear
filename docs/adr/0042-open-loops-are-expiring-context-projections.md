---
status: accepted
date: 2026-07-26
---

# Open Loops Are Expiring Context Projections

An Open Loop represents only a concrete upcoming event or awaited outcome
directly supported by User Evidence. It is a short-lived, versioned Context
projection with a required expiration, not a Memory Claim, Profile item,
unfinished topic, emotion, reminder, goal, or task. When the same event is
also eligible for a time-bound Objective Memory or Episode, the Open Loop
references that source Version rather than duplicating the fact.

Explicit User Evidence can close an Open Loop as completed or canceled, and a
deterministic expiry job can mark it expired. Closed and expired Loops leave
current Context but do not delete their source Evidence, Claim, Episode, or
Journal history. Only an open, unexpired Loop that is naturally relevant to
the current user-initiated conversation may be compiled into Context. Open
Loops never send notifications, create task lists, or measure completion.
In-conversation proactive follow-up is governed by ADR-0043.
