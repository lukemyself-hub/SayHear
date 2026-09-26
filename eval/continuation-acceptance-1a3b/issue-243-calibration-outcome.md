# Issue #243: G2 v6 real Provider calibration outcome

**Decision: bounded failure.** Both independent synthetic development sets failed their frozen gates. No expression configuration is promoted. Formal sampling, formal Provider capture, and review-page generation for tasks 5–7 remain blocked. The raw outputs, verifications, and per-file SHA-256 values are preserved in `run-v6-calibration-{1,2}/` and `run-v6-calibration-evidence-hashes.json`.

## Frozen setup and execution

- Round 1 plan: `calibration-plan-v6-round-1.json`, `sha256:e1cf7178ee1b93abf638fe96fc6cbea9a5eb5b076c345af4c60773f2a7aee8e3`. Round 2 plan: `calibration-plan-v6-round-2.json`, `sha256:ce7f38a9340baa4b77e48147d8bcb7b04679bad9c1babbc04f5c2a80b55aeadc`. Each plan freezes the 44-scene catalog, scene bytes, prompt/model/effort/adapter/Egress pins, comparison order, and rules. Preflight checked exact Event text, target source text, and scene ID separation from v4/v5, #241, and the other development set. The formal Valecrest/谷岭 pool was reserved but not built, so its disjointness remains a declared boundary rather than a verified artifact.
- Each set has 8 scenes in each of four positive families, 3 probes per omission reason, and English, Chinese, and code-switch coverage (16/16/12). All scenes are synthetic. Main conversation replies were independently called once per declared turn: 104 responses per set. OFF and all three ON configurations replayed the same frozen main text within each set. No failed Provider result was redrawn.
- Prompt comparison: `prompt-v5` versus `prompt-v6`, both Flash/none. Configuration comparison: `prompt-v6` Flash/none versus `effort-low` Flash/low with a larger 800-token output cap. The latter is a complete configuration contrast, so any difference cannot be attributed to effort alone. All calls used the real DeepSeek adapter, Provider Egress, and the configured local credential; the calls completed through those boundaries. The pinned `deepseek-v4-flash` name is a legacy alias now routed to V4.1-Flash according to [DeepSeek's pricing documentation](https://api-docs.deepseek.com/quick_start/pricing/).
- Before expression calls, the main-response audits recorded target coverage, ordinary questions, earlier target mention, local window, and natural opportunity for each of the 44 declared t2 review turns. They did not adjudicate every direct-task or state-transition main turn before expression; this limits claims about those turns. The original declarations and all 32 positive turns per set remained in the reports.

## Full positive funnel

`q skip` is the mechanical question detector, and `eligible` is the verifier's executable denominator after all earlier gates. Human semantic question judgments differ from that detector and are discussed below. `emit` counts complete committed emits on the declared positive opportunity, not every later segment in a scene.

| Set | Configuration | Declared | q skip | Other stage skip | Incomplete view | Executable | Selected / calls | Complete emit | Typed omit | Technical failure | Recall |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | prompt-v5 | 32 | 17 | 4 | 4 | 11 | 6 / 6 | 2 | 4 | 0 | 2/11 |
| 1 | prompt-v6 | 32 | 17 | 4 | 4 | 11 | 6 / 6 | 2 | 4 | 0 | 2/11 |
| 1 | effort-low | 32 | 17 | 4 | 4 | 11 | 6 / 6 | 1 | 4 | 1 | 1/11 |
| 2 | prompt-v5 | 32 | 22 | 0 | 0 | 10 | 7 / 7 | 6 | 1 | 0 | 6/10 |
| 2 | prompt-v6 | 32 | 22 | 0 | 0 | 10 | 7 / 7 | 6 | 1 | 0 | 6/10 |
| 2 | effort-low | 32 | 22 | 0 | 0 | 10 | 7 / 7 | 1 | 0 | 6 | 1/10 |

The conditional round-2 6/10 is only 6/32 of predeclared positives; it cannot erase the 22 main-question skips. The round-2 pre-expression human audit judged 23/32 positive t2 main replies to contain an ordinary question or conversational invitation, versus 22/32 mechanical skips. The `ol-004:t2` main invitation was marked as a semantic question, yet both none-effort configurations appended a question there. This is a precision concern beyond the mechanical verifier. The `state-004:t4` extra segment came after `state-004:t2` main had already asked about the target; it does not establish a complete stateful anchor. Neither extra segment is a reason to promote.

The prompt-v6 language slices below count the declared t2 turn only. A `commit` here is the machine result before semantic exclusion of `ol-004:t2`.

| Set | Language | Declared | Mechanical question skip | Selected | Commit | Typed omit |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | English | 12 | 8 | 2 | 1 | 1 |
| 1 | Chinese | 12 | 6 | 2 | 1 | 1 |
| 1 | Code-switch | 8 | 3 | 2 | 0 | 2 |
| 2 | English | 12 | 8 | 2 | 2 | 0 |
| 2 | Chinese | 12 | 9 | 3 | 3 | 0 |
| 2 | Code-switch | 8 | 5 | 2 | 1 | 1 |

The same frozen main replies gave identical mechanical question skips and selections for the other configurations. On round 2, prompt-v5 t2 commits by language were 1/3/2; low gave 0/1/0 and two technical failures in each language. Across each configuration and set, protected direct-task (24 turns), refusal (3), short-answer (3), and topic-change (2) turns had zero committed G2 segments. These are observed protected slices, not a substitute for the missing formal negative pool.

Round 1's main audit identified only 4 natural positive opportunities; round 2 identified 7. The main reply often raised the target itself. The exact raw main text and audits are frozen; these are input/opportunity findings, not proof that Provider expression alone caused the failure.

## Candidate formation, reasons, and semantic review

- In round 1, every configuration made 121 Open Loop extraction attempts and formed 0 proposals. The original Event phrasing did not give this extractor usable pending-result candidates. The revised round-2 Event directly says a request was submitted, names the deciding coordinator, deadline, and unknown result. Round 2 made 125 extraction attempts per configuration, forming 8 proposals for each none-effort configuration and 9 for low effort. Even then, 5 of 8 `positive_open_loop` scenes had no formed target in the v6 prompt ledger. Missing targets and competing targets are deterministic verifier failures.
- Round 1 `prompt-v6` matched only 0/3 `no_genuine_opportunity`, 1/3 `duplicates_main_response`, 1/3 `insufficient_grounding`, and 2/3 `timing_not_natural` declared probes. Round 2 matched 0/3, 2/3, 0/3, and 2/3 respectively. These counts require a real typed omit with the **declared reason**, not just any omission. The other configurations also failed reason stability; see each `calibration-report.json`.
- Human semantic adjudication of the round-2 called probes confirms `omit-05/06` as duplicate of the main reply and `omit-10/11` as interrupted timing cases. `omit-03` returned `duplicates_main_response` against a declared `no_genuine_opportunity` probe; the main itself recalled the gray pencil, so duplicate is semantically plausible but the probe failed to isolate its declared reason. `omit-07/09` have vague target memory, but the main already discusses that vagueness or asks another question, so neither yielded a clean `insufficient_grounding` call. `omit-01/02/04/08/12` did not reach expression because of main-question or selection gates. Round 1 similarly had `omit-02` return duplicate despite its `no_genuine_opportunity` declaration; its main had mentioned the selected subject. No typed reason is upgraded to a success by string matching alone.
- Round 2 prompt-v6 has 24 verifier failures, including missing Open Loop/competing candidates, wrong or unreached omission probes, and absent eligible selections. The other two configurations failed 25 and 30 checks. No formal negative pool was created; protected direct-task turns emitted no G2 segment in these captures, but that does not prove the future formal negative precision gate. Source identity and local time remained synthetic and were checked structurally; no real Internal Owner data was used.
- The reviewed committed segment texts did not assert that a pending result had arrived or attribute a User Event to a third party. They generally asked whether the result or project had progressed. This is a narrow manual observation over the recorded emits, not a passing subject/time gate: five round-2 Open Loop positives had no candidate, and the stateful anchor and semantic-question failures prevent end-to-end validation. Local dates and source evidence are in the frozen scenes and treatment ledger.
- Prompt-v5 and prompt-v6 each made 13 expression calls in round 2, with 0 technical failures; low made 13 with 7 technical failures. Round 1 had 15 calls per configuration, with 5 technical failures for low and 0 for both none-effort prompts. The evaluator preserves `failed` separately from typed omit. It does not store the raw Provider response or detailed failure subtype, so the precise low-effort failure cause is unverified.

## Family rates and blocked work

The analyzer's conditional round-2 `prompt-v6` rates were Open Loop 1/2, Memory 1/1, Stateful 1/3, Competing 3/4. Round 1 had zero complete emit in Open Loop and Stateful. The conditional round-2 rates are **not promoted p values** because the reason, candidate, and semantic-question gates failed; the denominator also excludes many predeclared turns. No formal scene-count formula is authorized from these values.

Actual monetary cost cannot be reconstructed: the current adapter/evaluator does not persist per-call input/output token usage or cache tier, and [DeepSeek bills on tokens at peak/off-peak and cache-dependent rates](https://api-docs.deepseek.com/quick_start/pricing/). The frozen evidence gives 208 main calls across both rounds, 121/125 extraction attempts per configuration per round, and 15/13 expression calls per configuration; it does not give a defensible currency total. This is an explicit instrumentation gap for any future calibration, not an estimated zero cost.

**Stop condition:** both allowed sets failed. Do not regenerate, filter, or run a third development set under #243. Tasks 5–7 remain blocked until a new, separately authorized remediation plan addresses candidate formation, sample opportunity quality, semantic question detection, omission probe isolation, low-effort technical failures, and usage accounting.

## Validation

`pnpm typecheck` passed. The plan verifier passed for both frozen rounds. The six treatment verifiers and six calibration analyzers exited nonzero by design and wrote the failing JSON reports; their failure counts and reasons are preserved. `pnpm test` ran once: 87 test files passed, 12 skipped, and 25 failed; 1,147 tests passed, 64 skipped, and 1 failed. The 24 system-suite setup failures required `TEST_DATABASE_URL`, which was not supplied to this run; the startup validation test exposed the already tracked Node/ESM startup issue (#223). The test runner also reported two connection errors from a localhost probe blocked in this sandbox. These failures do not establish a new v6 calibration regression, but the full suite is not green. Earlier targeted `g2-v5-review` and `issue-240-diagnosis` tests passed (13 tests).
The broader `eval/tsconfig.check.json` typecheck still reports eight pre-existing diagnostics in v5 and other eval files; it reported none in the v6 files changed here.
