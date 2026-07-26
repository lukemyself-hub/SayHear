---
status: accepted
date: 2026-07-25
---

# Replay isolation is gated by private data

Initial Replay uses synthetic, anonymized, or independently authorized eval datasets and may run locally, in CI, or through a controlled in-process path. It can write only non-authoritative eval output, cannot read production domain sources, and does not require a separate deployment, job-scoped snapshot API, or Provider Egress Gateway.

Before any Replay reads the Internal Owner's real private source, SayHear must deploy an isolated Private Replay Runtime with no production database credential or authoritative write permission. Private Replay obtains only an explicitly selected immutable source through a job-scoped snapshot API and must pass the Provider Egress trust-boundary review before execution.
