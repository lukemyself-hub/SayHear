---
status: accepted
date: 2026-07-26
---

# Relationship roles are evidence-backed Qualifiers

A Relationship Predicate represents the underlying relationship, while
specific role terms such as mother, son, older sister, or husband are
Relationship Qualifiers on an immutable ClaimVersion. Each Qualifier has its
own direct User Evidence and can be refined, contested, or retracted without
changing the logical Claim identity or becoming a global Entity attribute.
When only a Qualifier conflicts, projections fail closed for that role and may
fall back to a Registry-defined neutral term while the base relationship
remains supported. A correction that changes the Predicate, Entity, or base
relationship affects the whole Claim instead. This adds versioned Qualifier
assertions and Evidence links, but avoids duplicate Predicates, unsupported
role inference, and unnecessary loss of a still-valid relationship.
