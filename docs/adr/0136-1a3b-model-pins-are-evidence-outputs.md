---
status: accepted
date: 2026-09-07
---
> Revised by [ADR-0148](0148-deployment-identity-config-authorization-and-acceptance-are-separate.md) where it concerns re-freezing the whole manifest when one role changes; per-role honesty is retained.

# 1A.3b model pins are evidence outputs

The 1A.3b SPEC fixes how each model role is evaluated, not a provider or model
winner chosen before the evidence exists. Only configurations supported by an
implemented adapter and a live Provider Egress and credential check may enter
evaluation. The acceptance manifest freezes the exact provider, model
snapshot, parameters, Prompt, Schema, and policy that won or passed.

`proactive.followup` and `bio.write` each compare at least two complete frozen
configurations because their user-visible quality needs blind pairwise
evidence. Structured roles may publish a sole available configuration only if
it passes every absolute labelled-data and deterministic gate. DeepSeek's
incumbent and an available OpenAI configuration are expected initial
candidates, not preselected winners; an unavailable candidate is recorded as
unavailable rather than treated as a loss or silently replaced.
