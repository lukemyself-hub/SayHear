---
status: accepted
date: 2026-07-26
---

# Only AI Impressions Use Time-Based Dormancy

A confirmed Objective Memory does not lose confidence or epistemic status
merely because the User has not mentioned it recently. Time-sensitive
Objective Claims use Predicate Registry temporal semantics and immutable
ClaimVersions to represent whether they are current or historical.

Every Predicate that permits AI Impressions defines a review policy. When an
active Impression reaches its review deadline without fresh qualifying
Evidence, SayHear creates a new `inferred + dormant` ClaimVersion and removes
it from Profile, Recall, Embedding, and cross-day narrative use. Dormancy does
not delete or retract the old Evidence or history. The Impression can return
only through another new active ClaimVersion after fresh Evidence again
satisfies the cross-Session admission policy; old Evidence, elapsed time, and
model confidence cannot directly reactivate it. Contrary Evidence uses the
contested path rather than being hidden as decay.
