---
status: accepted
date: 2026-07-25
---

# Entity changes suspend affected Memory Claims before revalidation

When an Entity is merged, split, or corrected, every current Memory Claim linked to the affected EntityVersion immediately stops participating in Recall and Profile projection. SayHear locates only affected Claims through reverse lineage; it does not scan all Memory. Retrieval also fails closed on an invalid or superseded EntityVersion, so there is no asynchronous window in which the old identity can still be recalled.

The old ClaimVersion remains immutable. SayHear revalidates the Claim against its original User Evidence and creates a new ClaimVersion before Recall can resume. If the Entity change alters the Claim's canonical identity, SayHear creates a new logical Memory Claim and supersedes or retracts the old one instead of replacing an Entity ID in place. Uncertain attribution remains `review_due` and excluded from Recall, Profile, Embedding, and cross-day narrative.

Entity merge does not mechanically union Evidence counts or confidence. Overlapping Evidence is deduplicated and revalidated against the merged identity before a canonical Claim can become active. This favors temporary omission over recalling one person's experience as belonging to another.
