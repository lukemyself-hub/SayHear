---
status: accepted
date: 2026-07-26
---

# Internal Tool Reviews Candidates Without Publishing Registry

Phase 1 includes a controlled Web developer tool for reviewing
`needs_predicate_review` MemoryCandidates. An authorized Internal Owner may map
a Candidate to an existing Predicate, reject it, or approve it for a versioned
Predicate Change Proposal. Mapping still runs normal admission, rejection uses
the terminal Candidate rules, and approval for a Registry change moves the
Candidate to `awaiting_registry_release`; none of these review actions directly
creates a Claim. ADR-0053 additionally records a product-value rejection as a
user-content-free rejected ProposalVersion, while candidate-specific rejection
does not create a Proposal.

The Web tool calls the Candidate Review Module and cannot write active Registry
entries. The Predicate Registry Governance Module separately owns Proposal
versions, code-repository TypeScript / YAML, mapping tests, migration, and
Registry publication. Only after a new Registry version is published may
linked Candidates re-enter normal mapping and admission. Candidate Evidence
remains behind Internal Owner diagnostic capability, step-up reauthentication,
and access audit.
