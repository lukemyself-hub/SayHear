---
status: accepted
---

# Journal delivery is automatic

SayHear automatically publishes a validated Journal after the conversation naturally closes or the Daily Session reaches its background eligibility condition. Users do not trigger generation or approve a draft. If more expression arrives for the same day, a new Journal Version supersedes the previous one. This keeps Journal generation as product delivery rather than returning a writing or review task to the user.

“Users do not trigger generation” only governs the first automatic Journal delivery.
After a current Journal exists, ADR-0097 allows a separate policy-governed Derived
Artifact Regeneration Action when the user is dissatisfied with its expression. That
request still uses the same validation and automatic publication boundary; it does not
introduce draft approval, free-form editing, custom style control, or repeated candidate
selection.

ADR-0011 refines the eligibility condition and the product state used when no Journal can be truthfully produced.
