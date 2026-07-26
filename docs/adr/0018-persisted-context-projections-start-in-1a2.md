---
status: accepted
date: 2026-07-25
---

# Persisted Context projections start in 1A.2

Core Flow 1A.1 compiles Context from a bounded set of committed raw Conversation Event Revisions and persists a versioned CompiledContext manifest. When those Events exceed the section budget, the Compiler keeps the newest Events that fit and records an explicit degraded reason; product, safety, relationship boundaries, and the current user input remain non-truncatable.

1A.1 does not create or consume model-generated SessionSummaryVersion or DialogueStateVersion. Those persisted Context projections begin in 1A.2, where durable asynchronous execution already exists. Daily Session activity, revision, and closure policy remain deterministic persisted domain state from 1A.1.
