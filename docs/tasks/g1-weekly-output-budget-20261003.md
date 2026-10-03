# G1 Weekly-only Output Budget Increase (10000 → 20000)

## TL;DR

- Owner (Luke) authorized exactly one change for G1: raise only
  `reflection.weekly` `maxOutputTokens` from 10000 to 20000, as a new immutable
  Weekly v5 configuration and shared rollout pin v11, then run controlled
  verification before acceptance/release.
- The Weekly prompt, model (`deepseek-v4-flash` requested, `deepseek-flash`
  snapshot observed), temperature, `reasoning.effort: low`, retries and
  `fallback: none` are unchanged. Daily, Episode and `narrative.validate` keep
  their current 10000-token configurations. Bio, Open Loop and Proactive remain
  off.
- The controlled 20000 replay is diagnostic evidence only. It is not frozen
  release evidence and must never be copied into a passed release artifact.

## Status

Accepted / implementation in progress.

## Decision

A single Weekly Provider request at the frozen 10000-token budget failed with
`response.incomplete` / `max_output_tokens`, usage input 8636 / output 10000 /
reasoning 10000, and no visible body. The authorized controlled replay of the
same synthetic 3-day W38 request at 20000 completed `typed_schema_accepted` with
input 8636 / output 13285 / reasoning 8571.

Because a configuration row is immutable on `(role, config_version)` and the
Provider egress policy identity is bound to that version, the raised budget
lands as:

- Weekly configuration `reflection.weekly:g1-release:v5` (unchanged
  `reflection-weekly:eval:v4` prompt), registered by the new immutable Weekly
  v5 egress policy.
- Shared rollout pin `v10` → `v11`, which also re-pins the three unchanged
  roles, because a pin is bound to exactly one manifest fingerprint.

## Evidence

| Field | Failing 10000 request | Controlled 20000 replay |
| --- | --- | --- |
| request | same synthetic 3-day W38 | same request |
| outcome | `response.incomplete` / `max_output_tokens` | `typed_schema_accepted` |
| input tokens | 8636 | 8636 |
| output tokens | 10000 | 13285 |
| reasoning tokens | 10000 | 8571 |
| visible body | none | typed output accepted |

The replay is a controlled diagnostic, not acceptance. Per ADR-0144, hosted
acceptance still requires an isolated deployment with the frozen code, Schema,
Prompt, policy, role configurations and Provider snapshots, followed by a
production promotion record. Per ADR-0143, no Reflection semantic verdict is a
G1 release gate; completion and role identity remain required.

## In scope

- `reflection.weekly` config `v4` → `v5` with `maxOutputTokens` 20000.
- Shared rollout pin `v10` → `v11`.
- New immutable Weekly v5 Provider egress policy; old policy rows retained.
- Weekly-only budget in `eval/continuation-acceptance-1a3b/g1-activation-pins.json`.

## Out of scope

- Any Prompt, Schema, model, snapshot, temperature, reasoning-effort, retry or
  fallback change; no other role's budget changes.
- Daily/Episode/Validator configurations; Bio/Open Loop/Proactive.
- Editing published migrations, old captures/manifests/ledger, validators,
  grammar, Reflection semantic criteria, auth code, or egress security.
- Treating the diagnostic replay as frozen release or hosted acceptance
  evidence.

## Acceptance criteria

1. The frozen factory and web runtime both resolve Weekly to 20000 output
   tokens, `reasoning.effort: low` and snapshot `deepseek-flash`.
2. Immutable identities are consistent: Weekly configuration v5 and all four
   rollout pins v11.
3. Episode, Daily and `narrative.validate` stay at their current configuration
   v5 budgets; `narrative.validate` stays at 10000. Bio/Open Loop/Proactive stay
   deferred.
4. The Weekly v5 egress policy exists so activation can bind the v5
   configuration; old rows remain.
5. Relevant typecheck and tests pass against two independent local databases
   with `maxWorkers=2`.
6. The new release evidence is produced only after a clean freeze; the
   diagnostic replay is never relabeled as acceptance.

## Required context

- [ADR-0058](../adr/0058-replay-recommends-and-humans-publish-model-routing.md)
- [ADR-0143](../adr/0143-g1-ships-without-semantic-reflection-validation.md)
- [ADR-0144](../adr/0144-g1-hosted-acceptance-isolated-from-production.md)
- [ADR-0145](../adr/0145-g1-raw-provider-error-probe-waiver.md)
- [ADR-0146](../adr/0146-f3-ordinary-double-questions-are-observations.md)
- [G1 activation execution record](../plans/g1-activation.md)

## Open questions

- Final hosted acceptance and production promotion remain owned by the parent
  task and are not claimed here.

## References

- [Documentation map](../README.md)
- [Decision index](../decisions.md)
