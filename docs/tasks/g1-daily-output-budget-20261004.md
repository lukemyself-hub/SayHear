# G1 Daily-only Output Budget Increase (10000 → 20000)

## TL;DR

- Luke explicitly authorized this Daily-only increase on 2026-10-04. His prior authorization covered
  exactly one Weekly budget increase
  ([g1-weekly-output-budget-20261003.md](g1-weekly-output-budget-20261003.md));
  it did **not** authorize Daily. The new authorization covers Daily 20000 and
  re-running acceptance before release; authorization itself is not acceptance.
- The proposal raises only `reflection.daily` `maxOutputTokens` from 10000 to
  20000, as a new immutable Daily v6 configuration and shared rollout pin v13,
  with a new immutable Provider egress policy. Weekly stays at 20000; Episode
  and `narrative.validate` stay at 10000.
- The Daily prompt (`reflection-daily:eval:v5`), model (`deepseek-v4-flash`
  requested, `deepseek-flash` snapshot observed), temperature, low reasoning
  effort, retries and `fallback: none` are unchanged. Bio, Open Loop and
  Proactive remain off.
- The synthetic diagnostic below is a bounded observation, not frozen release
  or hosted acceptance evidence. The candidate result is one stochastic call,
  not a deterministic replay guarantee.

## Status

Luke approved Daily 20000 on 2026-10-04: “同意 Daily 提高到 20000，并继续验收上线”.
The candidate patch passed independent review and 1459 regression tests, but
has not been committed, frozen or deployed.

Luke subsequently requested a high-cap complete task with token monitoring,
followed by analysis of redundant work and budget optimization. Freeze and
promotion are paused for that experiment. The local diagnostic uses separate
100000-token configurations for the four G1 roles, wholly synthetic inputs,
and real generation, validation and domain commits. These temporary
configurations do not change production budgets or constitute release proof.

## Why this is separate from the Weekly authorization

The Weekly task was authorized for exactly one change: raise only
`reflection.weekly` to 20000. That change is implemented (Weekly configuration
v5, shared pin v12 at the time of writing) and is not re-opened here. The Daily
budget is a distinct role with an independently frozen contract
([ADR-0132](../adr/0132-1a3b-model-roles-fail-independently.md)); raising it is
a separate decision, now explicitly authorized by Luke.

## Evidence (wholly synthetic, diagnostic only)

A wholly synthetic Daily-scope probe was run against the frozen commit
`0844e9c` with `gitDirty=false` and `preflight=true`. The probe used synthetic
data only and read no wrapper, credential or raw private input.

| Field | Failing 10000 probe | Companion 10000 probe | Candidate 20000 probe |
| --- | --- | --- | --- |
| scope / locale | daily / en-US | daily / en-US | daily / en-US |
| evidence items | 24 | 22 | 24 |
| days / baselines | 1 / 2 | 1 / 2 | 1 / 2 |
| `maxOutputTokens` | 10000 | 10000 | 20000 |
| outcome | failed `output_budget_exhausted` | completed | completed, typed |
| provider reason | `max_output_tokens` | — | — |
| input tokens | 4081 | 3714 | 3982 |
| output tokens | 10000 | 2854 | 3507 |
| reasoning tokens | 6844 | 1283 | 883 |
| output length | 9201 | — | — |

- The requests ran in `en-US`; the top-level `locale` field in the raw
  synthetic report is stale `zh-CN` and must not be used.
- The failing probe hit the 10000-token cap and emitted no accepted typed body.
  The cap counts visible plus reasoning tokens; `reasoningTokens` 6844 is not
  the entire cap. The companion 22-item baseline completed within the same cap.
- The 20000 candidate call completed with typed output under the same synthetic
  request shape. It is a **stochastic, independent call**: it does not
  deterministically replay the failing request and does not by itself prove
  release acceptance.
- The actual hosted Daily path shows 22/24 evidence-item counts, but the exact
  hosted cause is not proven from this diagnostic. This diagnostic does not
  establish that the hosted path exhausted its budget.

Reports (safe, synthetic diagnostics): `/private/tmp/g1-0844e9c-fragmented-synthetic-results.json`
and `/private/tmp/g1-0844e9c-candidate-budget-results.json`.

## In scope

- `reflection.daily` config `v5` → `v6` with `maxOutputTokens` 20000.
- Shared rollout pin `v12` → `v13`.
- New immutable Daily v6 Provider egress policy; old policy rows retained.
- Daily-only budget in `eval/continuation-acceptance-1a3b/g1-activation-pins.json`.

## Out of scope

- Any Prompt, Schema, model, snapshot, temperature, reasoning-effort, retry or
  fallback change; no other role's budget changes.
- Weekly (stays 20000), Episode and `narrative.validate` (stay 10000).
- Bio, Open Loop and Proactive (remain off).
- Runtime schema loosening, semantic tuning, recovery retry, validators,
  grammar, Reflection semantic criteria, auth code or egress security.
- Editing published migrations, old captures/manifests/ledger, or archived run
  artifacts.
- Treating the synthetic diagnostic as frozen release or hosted acceptance
  evidence, and any freeze, activation, deployment or production promotion.

## Acceptance criteria for the approved candidate

1. The frozen factory and web runtime resolve Daily to 20000 output tokens,
   `reasoning.effort: low` and snapshot `deepseek-flash`.
2. Immutable identities are consistent: Daily configuration v6 and all four
   rollout pins v13.
3. Weekly stays at 20000; Episode and `narrative.validate` stay at 10000;
   Bio/Open Loop/Proactive stay deferred.
4. The Daily v6 egress policy exists so activation can bind the v6
   configuration; old rows remain.
5. Relevant typecheck and scoped configuration tests pass.
6. New release evidence is produced only after a clean freeze; the synthetic
   diagnostic is never relabeled as acceptance.

## Required context

- [ADR-0132](../adr/0132-1a3b-model-roles-fail-independently.md)
- [ADR-0143](../adr/0143-g1-ships-without-semantic-reflection-validation.md)
- [ADR-0144](../adr/0144-g1-hosted-acceptance-isolated-from-production.md)
- [Weekly budget task](g1-weekly-output-budget-20261003.md)
- [G1 activation execution record](../plans/g1-activation.md)

## Open questions

- Luke's authorization for a Daily-only budget increase is not yet given.
- Final hosted acceptance and production promotion remain owned by the parent
  task and are not claimed here.

## References

- [Documentation map](../README.md)
- [Decision index](../decisions.md)
