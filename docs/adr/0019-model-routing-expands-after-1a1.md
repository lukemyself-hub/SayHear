---
status: accepted
date: 2026-07-25
---

# Model routing expands after 1A.1

Core Flow 1A.1 uses one configured Conversation Text Champion and one Provider adapter behind a narrow ConversationTextModel port. It persists model configuration and ModelRunAttempt metadata, but does not implement capability matching or automatic model or Provider fallback; technical retries keep the same frozen model configuration.

Core Flow 1A.2 introduces a Role-based Model Registry when Journal and Evidence create distinct generation responsibilities; Core Flow 1A.3 adds Entity, Reflection, and Memory roles as their consumers appear. Core Flow 1A.4 introduces the full Capability Registry, additional Provider adapters, Champion/Challenger comparison, and versioned fallback policies only after Replay has demonstrated their quality and safety. Real private conversations are never automatically shadowed.
