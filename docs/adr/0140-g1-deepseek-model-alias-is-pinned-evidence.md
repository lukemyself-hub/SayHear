---
status: accepted
date: 2026-09-13
---

# G1 DeepSeek model alias is pinned evidence

DeepSeek currently serves the G1 roles under the mutable alias
`deepseek-flash` and returns that same alias as the model snapshot; no
immutable dated provider model ID is available to freeze. G1 accepts the
alias as the pinned `modelSnapshot` as a bounded exception to ADR-0136's
immutable-snapshot rule.

The exception holds only with the full pin intact: exact provider, model,
alias snapshot, parameters, Prompt, Schema, and policy versions frozen in the
F3 manifest and G1 role configurations; runtime refusal on any returned
snapshot mismatch; and per-role successful provider-call evidence with call
identity bound to those pins (AC-M01). An alias move by the provider is
treated as a pin change: it fails closed at runtime and requires a new
evaluation, not a silent carry-over.

When DeepSeek (or an alternative candidate) offers an immutable model
version identifier, G1 adopts it and re-runs the affected F3 and provider
evidence. This ADR does not weaken the precision, recall-budget, or
deterministic hard-gate rules.
