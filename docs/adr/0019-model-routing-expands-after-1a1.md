---
status: accepted
date: 2026-07-25
---

> **Amended by [ADR-0102](0102-deepseek-joins-openai-as-a-conversation-text-provider-in-1a1.md)
> on the single-adapter clause only.** ADR-0102 adds DeepSeek as a second
> Provider adapter in 1A.1 while preserving this ADR's invariant: still one
> configured active Champion, no capability matching, no automatic fallback.

# Model routing expands after 1A.1

Core Flow 1A.1 uses one configured Conversation Text Champion and one active Provider adapter behind a narrow ConversationTextModel port. It persists model configuration and ModelRunAttempt metadata, but does not implement capability matching or automatic model or Provider fallback; technical retries keep the same frozen model configuration.

Core Flow 1A.2 introduces a Role-based Model Registry when Journal and Evidence create distinct generation responsibilities; Core Flow 1A.3 adds Entity, Reflection, and Memory roles as their consumers appear. Core Flow 1A.4 introduces the full Capability Registry, additional Provider adapters, Champion/Challenger comparison, and versioned fallback policies only after Replay has demonstrated their quality and safety. Real private conversations are never automatically shadowed.
