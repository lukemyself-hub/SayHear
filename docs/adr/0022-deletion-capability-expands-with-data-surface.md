---
status: accepted
date: 2026-07-25
---

# Deletion capability expands with the active data surface

Foundation and Core Flow 1A.1 establish first-day privacy boundaries before real private content is written: stable owner identity, `data_epoch`, read and Provider Egress fences, deletion-compatible lineage, redacted observability, encryption in transit and at rest, and a verified backup retention window. They do not implement a general deletion API, workflow, ledger, recovery drill, or consumer interface.

Core Flow 1A.2 introduces an operator-only Internal Owner Full Purge. It revokes access and Provider egress, advances the epoch, clears Conversation, Evidence, Journal, and every derivative then present, emits active-system receipts, and writes a minimal content-free purge marker outside the business database backup domain. Core Flow 1A.3 extends that purge to Entity, Episode, Reflection, Memory, Profile, and related indexes; Core Flow 1A.4 adds Replay data; Core Flow 1B.1 adds audio and transcript data; Core Flow 1B.2 adds delivery metadata and buffers. Internal Core does not provide granular Conversation or Journal deletion and does not claim `fully_expired`.

External MVP must productize user-triggered Account Deletion and complete the multi-user deletion ledger, Provider destination reconciliation, backup restore anti-resurrection drills, and user-facing retention explanation before handling external users.
