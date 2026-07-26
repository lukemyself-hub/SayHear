---
status: accepted
date: 2026-07-25
---

# Durable Workflow and outbox start in 1A.2

Core Flow 1A.1 runs conversation generation on the request path, persists authoritative state in PostgreSQL, and uses one lightweight scheduled scanner for inactivity expiry and stuck-Turn reconciliation. It retains GenerationCommand and ModelRunAttempt, but does not require Vercel Workflows, WorkflowCommand, transactional outbox, or an outbox dispatcher.

Core Flow 1A.2 introduces Vercel Workflows and the transactional outbox when Journal and its deletion propagation first require reliable asynchronous execution. Core Flow 1A.3 reuses that foundation for Entity, Reflection, and Memory. This keeps 1A.1 recoverable without making a complete asynchronous workflow platform a prerequisite for the first Text vertical slice.
