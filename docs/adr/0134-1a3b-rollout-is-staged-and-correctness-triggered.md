---
status: accepted
date: 2026-09-07
---

# 1A.3b rollout is staged and correctness-triggered

1A.3b deploys through three direct-cutover stages: first the schemas, Episode,
Reflection, governance, and Inspector capabilities; then the complete
Proactive Memory Follow-up policy bundle; finally Bio after both validator and
narrative acceptance. Each stage freezes its own code, Prompt, Schema, policy,
model configuration, and bundle pins. Rollback disables or re-pins only the
affected stage; already written typed rows remain frozen history and are not
rewritten, deleted, or reinterpreted. Historical Conversations are not
backfilled.

One human-confirmed privacy, lineage, Data Epoch, Full Purge, resurrection,
unsafe publication, stop-signal, or other deterministic hard-gate failure
triggers immediate rollback of the affected stage. Timeout rate, Provider
errors, latency, token use, cost, and generation success remain accounting
signals in the single-owner phase and never offset correctness; they do not
automatically roll back a safely degraded capability.

Rollback first stops new command admission and removes the affected stage's
active rollout pins. A result frozen under removed pins cannot later become
current, enter Context, or display. Re-enablement requires compatibility with
the new Schema and policy pins; Bio must regenerate and validate rather than
restore an old visible version. Proactive suppression and use history remain
authoritative across rollback, so deployment changes cannot erase a user's
stop signal.

Each stage may merge and cut over independently only after its own
deterministic, migration, Purge coverage, role-configuration, and experience
gates pass. A successful early stage is not completion of Core Flow 1A.3b;
final acceptance waits for every stage and the full exact-main regression.
