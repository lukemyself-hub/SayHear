---
status: accepted
date: 2026-07-26
---

# Person relationships are versioned Memory Claims

An Entity represents a person's stable identity. Colleague, friend, partner,
parent, and similar relationships are Objective Memory Claims
supported by User Evidence and temporal validity; one Entity can participate in
multiple relationships at once or different relationships over time, and a
relationship change does not create a new Entity.

Relationship terms may help resolve an EntityMention, but they do not uniquely
identify an Entity. They therefore do not persist as `relationship_name` Entity
labels. A localized Relationship Resolver Hint is a rebuildable,
non-authoritative projection of a Relationship Claim's current version and
temporal state; an ended partner Claim may project “ex-partner” without
duplicating the fact as another Claim. The Hint can accelerate Mention
resolution and person-card rendering, but cannot become identity, Evidence, or
a second Context Memory. This adds explicit temporal relationship state while
keeping recall simple and avoiding duplicate Entities or facts.
