# #252 `narrative.validate` Response Diagnosis

Status: **diagnostic only — not release evidence.**
Executed: **2026-09-28, 05:30–06:25 UTC** (local 2026-09-27 22:30–23:25 PDT).
Author: agent session, at Luke's request. Adjudication owner remains Luke.

Read this before trusting any number below. Section 6 lists three integrity
problems with these artifacts; one of them means the `p4000` runs must not be
promoted into a release manifest.

## 1. What was asked and what this is

Issue #252 requires a *safe diagnosis* first: prove or disprove, per case,
whether `narrative.validate` is losing responses to an exhausted output
budget, and only then choose a versioned new configuration.

This document and the artifacts beside it are that diagnosis. They are
**not** the holdout run the issue requires for acceptance, and they are not
the 12 release-evidence sources. The 18 calibration fixtures have now been
used for diagnosis, so they can no longer serve as the acceptance holdout.

## 2. Provenance

| Item | Value |
| --- | --- |
| Repository state | worktree `codex/g1-release-status`, branch `codex/g1-release-status` |
| Diagnostics commit | `4e9fd06` |
| Earlier diagnostics commit | `969e2e6` |
| Provider | `deepseek` |
| Model | requested `deepseek-v4-flash`, Provider resolves to `deepseek-flash` |
| Frozen pin under test | `narrative.validate`, `promptVersion` `narrative-validate:eval:v4`, `schemaVersion` `narrative-findings:v1`, `temperature` 0, `maxOutputTokens` 4000 |
| Fixture catalog | sha256 `aeac56e594c5ae95b95af18c9d3880801c4f0bb2431bc6206b64881079218ae6` |

The `deepseek-v4-flash` request name is an alias. The Responses endpoint
reports only two supported names — `deepseek-flash` and `deepseek-v4-pro` —
and resolves the alias to `deepseek-flash`, which is why the frozen
`modelSnapshot` of `deepseek-flash` matches.

## 3. Finding 1 — the root cause is proven, and it is uniform

Across two full 18-case runs at the frozen 4000-token budget, **every single
failure was output-budget exhaustion, proven by the Provider's own
`incomplete_details.reason = "max_output_tokens"`.** There were zero
`parse_failed`, zero `schema_mismatch`, and zero `empty_output` results.

| Run | Commit | Result | Failed cases |
| --- | --- | --- | --- |
| 1 | `969e2e6` | 4 failed / 14 completed | `bio-contradiction-en`, `reflection-manifest-en`, `bio-unsupported-zh`, `bio-contradiction-zh` |
| 2 | `4e9fd06` | 7 failed / 11 completed | the above except `reflection-manifest-en`, plus `reflection-manifest-zh`, `bio-unsupported-mix`, `bio-contradiction-mix`, `bio-absence-mix` |

The issue recorded 7 failures on the incumbent commit. **8 of the 18
distinct cases (44%) failed at least once** across the two runs.

The issue's wording — "budget insufficiency is the strongest current
inference, not yet proven same-source per case" — can now be retired. It is
same-source, and it is proven rather than inferred.

## 4. Finding 2 — the budget went to reasoning, not to the answer

This is the decisive evidence, and it only exists because `reasoning_tokens`
was added to the failure record.

Run 2, per failure: `outputTokens` / `reasoningTokens` / visible characters.

| Case | output | reasoning | visible output |
| --- | --- | --- | --- |
| `bio-contradiction-en` | 4000 | 4000 | **0 chars** |
| `bio-unsupported-zh` | 4000 | 4000 | **0 chars** |
| `bio-contradiction-zh` | 4000 | 4000 | **0 chars** |
| `reflection-manifest-zh` | 4000 | 4000 | **0 chars** |
| `bio-unsupported-mix` | 4000 | 4000 | **0 chars** |
| `bio-absence-mix` | 4000 | 4000 | **0 chars** |
| `bio-contradiction-mix` | 4000 | 3946 | 54 tokens / 205 chars |

In 6 of 7 failures the model consumed the entire pinned budget on reasoning
and emitted **zero visible characters** — it never began to answer. Input was
never a factor: `inputTokens` was 469–476 against a 4000-token output budget.

The seventh case is a second sub-mode: reasoning took 3946, the answer began,
and it was truncated mid-stream.

A 4000/4000 split with 0 visible characters is the signature of a reasoning
loop, not of an answer that was too long. This matters for the remedy: the
budget was never close to being enough to hold the answer.

## 5. Finding 3 — the failure is stochastic, and the gate must account for it

The frozen pin, the same catalog, the same `temperature: 0`, produced 4
failures in one run and 7 in another, over a largely different case set. The
diagnostics commits changed no request byte — they only read the stream — so
this variance is entirely Provider-side.

A Provider that does not honour `temperature: 0` for reasoning spend cannot
be pinned into a deterministic gate on a single successful run. Any release
decision here needs repeated runs, and `18/18 completed` from one run is not
evidence of determinism.

## 6. Finding 4 — what a larger budget actually buys

The 7 cases that failed in run 2 were re-run at two larger budgets. Each
budget has its own manifest, so each artifact carries a fingerprint that
matches the configuration it actually used.

| `maxOutputTokens` | Result | Detail |
| --- | --- | --- |
| 4000 (frozen) | 0 of 7 completed | all `output_budget_exhausted` |
| 6000 | **6 of 7 completed** | `bio-unsupported-zh` still failed: reasoning 5835, 559 visible chars, truncated mid-answer |
| 8000 | **7 of 7 completed** | — |

So 4000 is definitively insufficient, 6000 is **provably** insufficient, and
8000 fixed every case that had failed. The worst requirement observed sits in
`(6000, 8000]`.

**The margin at 8000 is unmeasured.** Token usage for *successful* calls is
recorded nowhere: not in the model-role ledger (`model_run_attempts` has no
usage columns on this path), and not in the capture report, which only carries
usage on failures. Without that, "8000 is enough" cannot be distinguished
from "8000 barely held", and the next run could still truncate.

## 6a. Finding 4b — the margin at 8000, and why the budget is not the lever

Resolved 2026-09-28, after successful-call usage was recorded. The full spent
18-case pool was captured three times at the 8000-token pin on one correctly
bound manifest (`sha256:a5696aa7`, HEAD `24ee6d7`).

| Run | Completed | Failed | Heaviest successful call |
| --- | --- | --- | --- |
| 1 | 17 / 18 | `bio-contradiction-mix` | 6502 |
| 2 | **18 / 18** | — | 7091 |
| 3 | **18 / 18** | — | 7626 |

Across 53 successful calls: `output` min 1144, p50 2837, p90 5379, max **7626**
— **95.3% of the cap**. Reasoning is **97.3% of output at the median**, and
98.8% at worst.

Three things follow, and the third overturns the recommendation in §6.

1. **The single case is stochastic, not stably broken.** `bio-contradiction-mix`
   failed once and completed twice, and the budget is the only thing that
   differs. It is not a deterministic defect.

2. **Per-case variance at `temperature: 0` is enormous.** The same input, the
   same pin, produced `bio-unsupported-mix` at 2098 and 6502 output tokens
   across runs — a threefold spread. The Provider does not honour
   `temperature: 0` for reasoning spend, so a single run carries real
   truncation risk regardless of budget.

3. **The upper tail tracks the cap, which means the budget is a clip, not a
   fix.** At 4000 the failures pinned at exactly 4000. At 8000 the heaviest
   *success* sits at 7626. Raising the ceiling moves the tail up with it. The
   demand is unbounded, so no finite budget converts a flaky run into a
   reliable one — it only changes how often the clip bites.

The visible answer is a small, roughly constant share of the spend: the three
`bio-contradiction-mix` attempts produced 0, 90 and 102 visible characters while
spending 8000, 7626 and 7091 total. This is not an answer that does not fit in
the budget. It is a model that spends the budget thinking and then writes a
sentence.

**Correction to §6.** "8000 fixed every case that had failed" was true of that
one seven-case sample and overstated as a conclusion. 8000 is a real
improvement — 4–7 failures per run became 0–1 — but it does not make the role
deterministic, and it should not be described as having fixed the problem.

## 7. Finding 5 — reasoning cannot be turned off, and effort cannot be set

The issue offers two remedies: raise the output budget, or shorten the
reasoning burden. The second is not reachable through model controls on this
endpoint.

**The endpoint silently ignores unknown parameters.** This was established
with a control, because the alternative reading is a trap:

| Request | Result |
| --- | --- |
| `bogus_param_xxyy: 1` (invented) | **200 OK** |
| `temperature: 99` (real parameter, invalid value) | **400**, "valid range is [0, 2]" |

A 200 therefore proves nothing. Every attempt to disable reasoning returned
200 *and still spent reasoning tokens*:

| Attempt | reasoning tokens |
| --- | --- |
| `reasoning: { effort: "minimal" }` | 25 |
| `reasoning_effort: "low"` | 29 |
| `reasoning_effort: "none"` | 40 |
| `thinking: { type: "disabled" }` | 37 |
| `enable_thinking: false` | 45 |

**There is no supported effort control at all.** None of these names are
documented for this endpoint, and all of them are no-ops.

An undocumented alias does produce a non-reasoning mode. `deepseek-chat`
returned `reasoning: 0` in 6 of 6 samples where `deepseek-flash` ranged from
177 to 4000. It is **not recommended**, for three reasons:

1. It is not a supported model name — the endpoint lists only `deepseek-flash`
   and `deepseek-v4-pro`.
2. It would invalidate the entire ADR-0139 18-case calibration, forcing a full
   re-run and a fresh per-case adjudication by Luke.
3. It emits almost nothing (`output: 9` tokens). `narrative.validate`'s task
   is verbatim atomic-proposition decomposition with precise `unsupported` vs
   `contradicted` vs `ambiguous` semantics — the part that needs reasoning
   most. Suppressing it trades a loud budget failure for a quiet quality
   failure that no gate would catch.

A separate probe reproduced the failure mode outside the harness: on a task
much simpler than the validator, `deepseek-flash` hit 4000/4000 with
`incomplete: max_output_tokens` in 1 of 6 samples. The failure is not
validator-specific.

## 8. Recommendation

1. **Raise `maxOutputTokens` to 8000, and stop there.** 4000 and 6000 are both
   provably insufficient. 8000 takes the observed failure rate from 4–7 per run
   to 0–1. But §6a shows the tail tracks the cap, so this is the last budget
   step worth taking on its own: a larger cap would move the truncation point
   without addressing the cause. Further budget increases should be treated as
   buying time, not correctness.
2. **~~Close the usage-recording gap before freezing the new pin.~~ Done.**
   Successful-call usage is now recorded on the entrypoint and in the capture
   report, which is what made §6a measurable. The new pin was frozen against
   measured headroom rather than an upper bound.
3. **Do not pursue disabling reasoning or tuning effort.** Neither exists on
   this endpoint (section 7).
4. **Treat the budget as necessary but not sufficient.** One case in three runs
   still truncates, and the same input varied threefold across runs at
   `temperature: 0`. A single acceptance run is not evidence of determinism.
5. **The prompt/task shape is the actual fix, and it is now urgent rather than
   optional.** Reasoning is 97.3% of output at the median; the visible answer
   is 2–3% of the spend. The five heaviest calls across the three runs are
   dominated by the `code_switch` variant. Tracking that signal down is the
   only route to a run that passes reliably, and it is #254.
6. **The gate must tolerate a residual miss.** At 8000 the expected result is
   0–1 failures per 18, which is inside the ADR-0139 ten-percent budget of one.
   The release should plan for one blocking failure being *possible*, not
   merely tolerated after the fact.

## 9. Integrity caveats

These artifacts are diagnostics. Three specific problems:

1. **The `p4000` run 2 report is mis-bound.** It reused the manifest built at
   `969e2e6` but executed on `4e9fd06`. The capture script does not verify
   that a manifest's `gitCommit` matches `HEAD`, so the mismatch passed
   silently. The data is still valid for its purpose — the pins are identical
   and the diagnostics commits cannot change Provider behaviour — but **this
   report must not be used as release evidence.** The `p6000` and `p8000`
   manifests were rebuilt with the correct commit and are correctly bound.
2. **`configVersion` is not version-distinguishing here.** The capture script
   hardcodes `narrative.validate:eval-capture:v1` regardless of pins, so the
   4000 / 6000 / 8000 reports share one config identity. The reports are
   self-describing only because they record `maxOutputTokens` explicitly.
   A real configuration change must go through a properly versioned pin.
3. **The catalog is spent.** The 18 fixtures have been used for diagnosis and
   cannot be the acceptance holdout. The 6-case precision run has not been
   executed at all.

## 10. Artifacts

Untracked, under `eval/continuation-acceptance-1a3b/run/diagnostic/`:

| File | Contents |
| --- | --- |
| `manifest.json` | pin manifest at `969e2e6` — see caveat 1 |
| `validator-classification.json` | p4000 run 1, 4 failed / 14 completed |
| `validator-classification-p4000-r2.json` | p4000 run 2, 7 failed / 11 completed, with reasoning split |
| `manifest-6000.json`, `pins-6000.json` | pin manifest for the 6000 probe |
| `manifest-8000.json`, `pins-8000.json` | pin manifest for the 8000 probe |
| `p6000/*.json` | 7 single-case reports at 6000 |
| `p8000/*.json` | 7 single-case reports at 8000 |

Reproduction, from the repository root with `DEEPSEEK_API_KEY` and
`TEST_DATABASE_URL` exported:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts
pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts \
  --out eval/continuation-acceptance-1a3b/run/diagnostic/manifest.json
pnpm exec tsx eval/continuation-acceptance-1a3b/run-validator-capture.ts \
  --manifest eval/continuation-acceptance-1a3b/run/diagnostic/manifest.json \
  --out eval/continuation-acceptance-1a3b/run/diagnostic/validator-classification.json \
  --continue-on-error
```

A larger budget needs its own manifest; passing altered pins to a manifest
built from other pins yields a report whose fingerprint does not describe the
configuration that ran.
