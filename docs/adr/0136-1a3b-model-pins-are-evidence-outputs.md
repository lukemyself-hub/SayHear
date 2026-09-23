---
status: accepted
date: 2026-09-07
---

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

## Amendment (2026-09-18, Luke-approved bounded exception)

For the G2 continuation round, `proactive.followup` binds
`proactive-expression-v2` as its sole verified configuration, and the
two-complete-configuration comparison is explicitly deferred (no separate
expression-style review is planned at this time). Rationale: the earlier
comparison produced no perceivable difference between its arms (9 of 15
scene-level verdicts were ties) because the review surface could not expose
expression-relevant differences; the accepted improvement direction is
Evaluation Scene / judged-content matching, not a new prompt variant. This is
a recorded, bounded exception, not a silent replacement: any later round that
introduces a competing configuration revives the comparison requirement
before a pin can claim a winner. `bio.write` is unaffected.

## Amendment (2026-09-20, Luke-approved failed-candidate iteration)

The frozen `proactive-expression-v2` ON-vs-OFF review lost 3–12 with no ties.
Luke authorized a replacement candidate for the next acceptance round rather
than promoting, rerunning, or editing v2. `proactive-expression-v3` adds a typed
`emit | omit` decision, target timing and subject-role context, and explicit
grounding/non-duplication rules. It is the sole candidate in the next
ON-vs-OFF round under the same bounded exception; it is not called a winner
until that new round passes. The failed v2 scores and captures remain frozen.

## Amendment (2026-09-23, Luke-approved v4 evidence iteration)

The v3 capture and its review package are frozen as a failed preflight: the full pool
produced 4 emits and 30 typed omissions, while 11 of 15 sampled scenes had no visible
ON/OFF difference. The v4 acceptance round keeps `proactive-expression-v4` as the sole
candidate under the bounded single-configuration exception. It does not claim a winner
before the dual-track review passes. The 15-scene pairwise sample is drawn only from
actual committed emits; 8 actual typed omissions are reviewed separately. Both outcomes
are recorded without altering prior captures, pins, or scores. Any future competing
expression configuration revives the complete-configuration comparison requirement.
