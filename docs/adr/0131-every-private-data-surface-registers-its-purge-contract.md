---
status: accepted
date: 2026-09-07
---

# Every private data surface registers its purge contract

1A.3b introduces a closed Purge Surface Registry as the authoritative inventory of owner-scoped database rows, object-store prefixes, caches, indexes, generated artifacts, Provider objects, and access grants. Every entry declares ownership, Full Purge disposition, private content fields, clear handler, verifier, receipt destination, deadline behavior, and restore-marker reapplication behavior. A schema migration or runtime integration that creates an owner-scoped private data surface without a registry entry fails its automated acceptance gate.

The registry owns coverage, not deletion orchestration or business data. Existing domain repositories and destination adapters still perform idempotent clear and verify work under the advanced Data Epoch; the purge workflow walks the frozen registry version and cannot report Active-System Deletion while any required active destination is unverified. This adds maintenance to each private-data change, but prevents a hand-maintained purge SQL list from silently omitting a new table or external destination.
