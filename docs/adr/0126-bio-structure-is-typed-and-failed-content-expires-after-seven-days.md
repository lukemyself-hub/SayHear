---
status: accepted
date: 2026-09-06
---

# Bio Structure Is Typed and Failed Content Expires After Seven Days

Bio persists as an owner-scoped `bios` aggregate plus immutable `bio_versions`, `bio_statements`, `bio_atomic_propositions`, `bio_claim_links`, `bio_coverage_units`, `bio_coverage_members`, and `bio_validation_findings`. Product reads use only validated typed rows; raw generator and validator responses remain ModelRunAttempt artifacts and never become the read model. Published BioVersions and their lineage remain until Full Purge, although superseded or trust-invalidated versions are not available through the product read path.

Private semantic content from failed, stale, or `needs_review` drafts expires after seven days or earlier Full Purge. After expiry, only content-free command, attempt, error-class, and timing metadata remains. Typed storage costs more tables than a single JSON document, but lets schema constraints, Inspector queries, lifecycle fences, and migrations operate without reinterpreting model-owned JSON.
