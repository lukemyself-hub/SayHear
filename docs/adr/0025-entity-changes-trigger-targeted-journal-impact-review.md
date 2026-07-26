---
status: accepted
date: 2026-07-25
---

# Entity changes trigger targeted Journal impact review

An Entity merge, split, or identity correction triggers a reverse-lineage review only for JournalStatements linked to the affected EntityVersion; SayHear does not scan or regenerate every historical Journal. Entity-bearing Statements retain typed EntityVersion links and roles in addition to Evidence links, so the review can distinguish a harmless name or identity consolidation from an incorrect attribution of an action, relationship, or cross-day connection.

If the corrected User Evidence shows that the original Statement remains true, the Journal does not change. An explicit user identity correction or a deterministic attribution error may create a new JournalVersion through Journal Correction. If the available Evidence cannot determine whether the original Statement is wrong, the affected Statement enters `needs_review` and the published Journal is not silently rewritten.

`needs_review` applies to the affected Statement, not the entire JournalVersion. The published Journal remains current and visible, while the Statement is excluded from Entity enrichment, cross-day narrative links, and future Recall. SayHear does not retry on a timer or turn the review into a user task. New relevant User Evidence, an explicit correction, or opening the affected Journal may trigger one idempotent check for the current Entity and Evidence revisions; opening the Journal shows only a low-key, nontechnical identity-uncertainty notice.

The review resolves to `no_change`, `correction_required`, or `still_ambiguous`. These outcomes respectively remove the retrieval fence, generate a superseding JournalVersion, or preserve the fence until future Evidence appears. Internal Core may expose the pending Statement and its Evidence in diagnostics, but External MVP does not create a consumer Review Inbox.

This keeps historical correction proportional to demonstrated error. It accepts that an ambiguous old Statement may require later review rather than paying the trust and computational cost of repeatedly rewriting the user's full Journal history.
