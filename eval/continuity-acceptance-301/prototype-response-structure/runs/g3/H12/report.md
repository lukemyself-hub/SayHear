# H12 Holdout: a corrected figure and a forgotten confidence stay out, a separate experience stays in — H12: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-41eb5128-9ed3-40b9-9858-97e6703060a1` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `3eee929a3ae0097678b17403b816720e2cd4916b2ff8ba9bda873950eec752c7`
- Oracle: sha256 `94cc66f83497e63b4629c72b87fa8934e0520ce0dd468b9722ffdc94d7ce5a12`
- Recent-context governance: `active`
- Reproducibility digest: `7d4760e8f434ca6724539848ca0233b6698db6a3a683cae0cf40a6f57eab19c7`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 787 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 12 messages, no duplicates. |
| `O-commit` The recap streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-week-read` The turn actually takes the history path for last week (a day of it is recorded as read). | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-corrected-in` The corrected wording reaches the Provider. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-superseded-out` The superseded wording and its adjacent assistant reply reach no Provider request. | objective | **PASS** | — | No excluded source reached the Provider or the compiled Context. |
| `O-independent-in` The independent experience reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-forget-out` Messages associated with the Forget request and their replies reach no Provider request. The association is seeded as fixture state, so this shows the exclusion mechanism, not what a real Forget would associate. | objective | **PASS** | — | No excluded source reached the Provider or the compiled Context. |
| `O-no-action` Asking for a recap triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-purge-race` A Full Purge racing a history turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet run an Owner Full Purge concurrently with a history turn over HTTP (the purge revokes the owner's web sessions, so the run cannot read its own result back); proven in-process in tests/system/history-purge-recovery.system.test.ts. This is a missing harness capability, not a product verdict. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-controls` The recap uses the corrected figure as the present state, keeps the independent experience, and brings back nothing that was corrected away or forgotten. | semantic | **NEEDS-REVIEW** | #320 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[work].chat.timing.firstVisibleTextMs=24013.35325 (CLI network, limit 3000)
- steps[work].chat.timing.committedMs=24576.432959 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `work`: read state `unread`, payload told the model `nothing`
  - `merge:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 4
    - time of message 4: 2026-11-13 (expected 2026-11-13)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `fix` (correct) @ 2026-11-13T11:45:00.000Z — ended `no terminal event`
  - user: "有个消息，今天 HR 私下 verbal 跟我讲，今年 year-end bonus 是 1.5 个月，而且 Q1 就会发。"
  - assistant: null
- `forget-colleague` (forget) @ 2026-11-14T09:00:00.000Z — ended `no terminal event`
  - user: null
  - assistant: null
- `work` (say) @ 2026-11-16T12:00:00.000Z — ended `assistant_committed`
  - user: "帮我捋一下，上周我都跟你说了哪些工作上的事？"
  - assistant: "上周你跟我说过两件事。周三晚上说的是 HR 私下口头跟你讲，今年年终是 2.5 个月，比去年多整整一个月，Q1 就发，你高兴得都不太敢在 pantry 里讲。周五晚上说的是你们这边在变——你的 project 被 merge 进 platform team，owner 从 Priya 换成刚调过来的一位 manager，周四那场 kickoff 特别冷场。"

## Source manifest (what reached the Provider)

- `work`: 4 of 10 seeded sources reached the request — `bonus-echo:user`, `bonus-echo:assistant`, `merge:user`, `merge:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `fix` | warm | — | — | — | — | — |
| `forget-colleague` | warm | — | — | — | — | — |
| `work` | warm | 38 ms | 24013 ms | 24576 ms | 24576 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 10798, output 3178
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8113013, ledger entries of unknown cost 0

## Remaining risks

- The Forget association in this case is written by the seed directly (fixture state naming the target messages), not created by the product's own Forget action. The run verifies only that the history path excludes associated sources, not that a real Forget would have associated them.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
