---
status: accepted
date: 2026-07-25
---

# Continuous Exchange End is deterministic

A continuous exchange ends only when the user explicitly expresses an ending or a versioned inactivity window expires. SayHear may generate a natural closing response or propose a closure candidate, but model judgment alone cannot change Daily Session state or trigger Journal eligibility.

The inactivity duration remains a tunable policy to be evaluated in Core Flow 1A.1, not a permanent product constant. An inactivity command freezes the expected dialogue revision and must fail its state transition when newer activity exists, preventing a stale timer from closing a resumed exchange.
