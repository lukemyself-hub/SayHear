---
status: accepted
date: 2026-09-07
---

# Reflection Prose Uses Owner Auth and Evidence Excerpts Require Step-Up

The Internal Core Reflection Inspector lets the authenticated Internal Owner read
Reflection prose with the owner-scoped `reflection_inspection:read` capability and
no repeated step-up. This capability is granted to the one Internal Owner in Phase
1 but is not automatically granted to future authenticated identities. Reading the
exact user Evidence behind a Reflection Statement still requires the existing
`conversation_content:read` capability and a step-up completed within ten minutes.

Every Evidence expansion attempt writes a content-free access audit before any
source text is returned. The audit records only allowlisted identities, target IDs,
outcome, reason, capability, and time. If the audit cannot commit, the read fails
closed. Ordinary Reflection prose and lineage reads do not create access-audit
rows.

This split keeps routine diagnosis usable for the only Phase 1 owner without
treating verbatim user expression as ordinary diagnostic metadata. A single login
for all content was rejected because it would weaken the existing source-content
boundary. Requiring step-up for every Reflection page was rejected because it
would add repeated friction without protecting the more sensitive operation: opening
the user's exact words.
