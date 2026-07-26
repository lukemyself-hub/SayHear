---
status: accepted
date: 2026-07-25
---

# Provider egress is an in-process port in 1A.1

Core Flow 1A.1 routes every model call through one in-process Provider Egress Port inside the modular monolith. The port owns provider-policy enforcement, source and data-epoch validity checks, consent checks where applicable, server-only Provider credentials, and content-free egress metadata. Application code cannot call Provider adapters directly.

1A.1 does not deploy a separate Provider Egress Gateway, authorization service, claim-and-fetch protocol, credential broker, or result-ingest network boundary. Before an isolated Replay Runner, Voice Worker, or another execution environment can process real private data, the project must review the trust boundary and extract a Gateway when that environment should not hold general Provider credentials or database access.
