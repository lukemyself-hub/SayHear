---
status: accepted
date: 2026-08-20
---

# Journal diagnostics do not block publication

Journal publication has two separate concerns: deterministic publication safety
and semantic review. The first concern must remain small, explicit, and
independently auditable. The second concern is useful for improving trust and
debugging, but model or heuristic judgments can be broad or wrong and must not
silently suppress a Journal.

## Decision

- The Journal Publish Gate retains only structural and Evidence provenance
  checks: valid draft shape, locale, non-empty statements, real Evidence IDs,
  user-originated Evidence, and `final` / `corrected` source status.
- `inferred_observation` is not persisted or required in the Journal model.
  Third-person observation remains a writing goal, not a machine epistemic
  classification.
- Fixed-word, regular-expression, lexical-overlap, uncertainty-token,
  first-person, omitted-Evidence, and all-Evidence-coverage checks are not
  publication rules.
- `journal.validate` is a diagnostic role. It returns an allowlisted
  `findings[]` collection associated with stable Statement IDs. It never
  returns a publication boolean or free-form rejection reason.
- Diagnostic Codes and detail Codes are fixed by the application. The Portal
  maps them to natural-language descriptions; model-generated messages are not
  displayed directly.
- Findings are persisted with the published JournalVersion and its validation
  result. A diagnostic provider timeout, malformed result, or unknown Code
  produces `diagnostic_status=unavailable` and does not prevent publication.
- Internal Portal displays Findings below the corresponding Statement. A hard
  Publish Gate failure is displayed as a Journal-level natural-language status,
  without exposing the failed draft.

## Consequences

This removes a hidden content-suppression path and makes the remaining hard
gate publicly explainable. It also means semantic quality issues can appear in
published Journal text and must be visible as diagnostics rather than silently
removed. Validator contract, prompt fingerprint, diagnostic status, and
allowlisted Findings remain auditable without storing failed draft content.

ADR-0007 remains the product-level decision that Journal may express an
evidence-backed observation; this ADR supersedes its requirement to persist an
`inferred_observation` Journal statement state and to make uncertainty wording
a publication gate.
