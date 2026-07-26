---
status: accepted
date: 2026-07-25
---

# Core Flow 1B splits transport from delivery precision

Core Flow 1B.1 establishes the Realtime transport baseline with LiveKit, canonical STT, turn mapping, long-pause handling, barge-in, reconnect, and `delivery_precision=turn_only`. A fully played response may become a complete Assistant Event; an interrupted or uncertain response stores no Assistant body, and the Provider session must be truncated or rebuilt so unheard remainder cannot affect the next turn.

Core Flow 1B.2 adds monotonic client playout receipts, a conservative confirmed cursor, transcript-to-time alignment, `partially_delivered` Assistant Events, and retention and deletion semantics for any short-lived delivery buffer. Only text that SayHear can prove the user heard enters subsequent Context. Both milestones remain part of Internal Core, and Core Flow 1B is complete only after 1B.2 passes its failure tests.
