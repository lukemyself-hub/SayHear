---
status: accepted
date: 2026-07-26
---

# Third-party relationships require direct User Evidence

A Relationship Memory Claim may connect any two Person Entities in the user's
scope; neither side must be the Self Entity. Both current EntityVersions must
be resolvable, and the relationship must come from direct User Evidence. If
either Mention remains unresolved or ambiguous, the Candidate remains
`needs_entity_resolution` and cannot become an active Claim.

SayHear does not create Objective Memory Claims through kinship closure,
friend-of-friend inference, organizational propagation, or other social-graph
guesses. “Tom is my sister Lily's husband” can establish a user-scoped
Lily–Tom relationship, but it does not automatically establish a Self–Tom
brother-in-law Claim. A third-party Resolver Hint retains its resolved anchor
and derives from one ClaimVersion only. This permits natural family, friend,
and work-network references while accepting a smaller graph rather than
fabricating transitive relationships.
