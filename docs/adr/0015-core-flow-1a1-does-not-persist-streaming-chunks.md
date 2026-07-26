---
status: accepted
date: 2026-07-25
---

# Core Flow 1A.1 does not persist streaming chunks

Core Flow 1A.1 persists the User Event and model-run identity before inference, then streams text best-effort without write-ahead chunk storage, rendered-chunk acknowledgements, or crash-resumable delivery. Only a fully completed and atomically committed Assistant Response becomes an Assistant Event and enters later Context.

If streaming is interrupted, the Interaction Turn and attempt are marked `interrupted`; the UI exposes the interruption and allows an explicit retry, but any partial text is excluded from authoritative history. After any token may have been shown, the system cannot silently regenerate different text as if it were the same answer.

Chunk-level persistence, acknowledgement, resume, or exact delivered-prefix reconstruction may be introduced for Realtime Voice or a future explicitly approved delivery channel only when evaluation demonstrates the need and a later ADR defines its retention and deletion semantics.
