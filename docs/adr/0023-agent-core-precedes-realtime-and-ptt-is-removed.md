---
status: accepted
date: 2026-07-25
---

# Agent Core precedes Realtime Voice and PTT is not a product slice

Internal Core completes the product-value foundation before adding a second interaction channel: Core Flow 1A.2 delivers the same-day Journal vertical slice, 1A.3 completes Entity, Episode, Reflection, long-term Memory, Profile, and future Recall, and 1A.4 adds Replay and multi-model evaluation. Core Flow 1B then introduces Realtime Voice directly.

Push-to-Talk is removed from Phase 1 scope, product input channels, fallback behavior, and acceptance criteria. It would duplicate recording, upload, TTS, delivery, retention, deletion, and UI semantics for a temporary interaction that is absent from External MVP. Realtime failure falls back to Text.

Core Flow 1B.1 may use a non-product Voice Preflight Harness with recorded fixtures, synthetic audio, or separately authorized samples to validate canonical STT, Transcript revisions, audio retention, and deletion before enabling live rooms. The harness does not create Conversation turns or a user-visible voice mode. Reintroducing Push-to-Talk would require a new product decision and ADR.
