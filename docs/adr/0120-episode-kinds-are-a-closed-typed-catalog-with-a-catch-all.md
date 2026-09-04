---
status: accepted
date: 2026-09-04
---

# Episode Kinds Are a Closed Typed Catalog With a Catch-All

Episode kinds are a small, code-versioned, closed catalog of coarse grouping
classes — one trip, one relocation, one project phase, one discrete occurrence
— plus a single generic `sh.episode.other` catch-all. The model may propose a
kind only from the catalog; it can never invent or freely classify kinds.
Unmapped proposals are deterministically downgraded to `other` rather than
rejected or queued for runtime governance, and new specific kinds arrive only
through a code release as an optional developer convenience, informed by
observing `other` accumulation in internal diagnostics. Unlike Predicate
Registry expansion (ADR-0047), kind expansion gates no admission, so no human
governance queue is needed.

Coverage of diverse user lives is carried by Episode content — label, anchors,
per-kind typed fields, evidence — never by the kind catalog, so the catalog is
not asked to enumerate all situations. The closed vocabulary is what keeps
deterministic continuation sound: the matched/unresolved test scopes candidate
episodes by same kind and overlapping temporal window, and each kind's typed
schema gives the deterministic validator concrete anchor fields to check. An
open, model-owned vocabulary would fragment same-concept episodes across
synonymous kinds, degrade the uniqueness test into semantic-similarity
merging — which ADR-0037 forbids as a merge basis — and leave the validator
with no schema to check against.

The real-world anchor and evidence gate is kind-agnostic and applies uniformly
to every kind including `other`, so nothing is lost when a proposal lands in
the catch-all. The broader `other` candidate pool is handled by the same
fail-closed rule as every other kind: when an anchor combination hits two or
more active episodes, or none, the candidate stays unresolved instead of
merging.
