# U12 Unseen: source control on the history path: a Correction, a Forget and an independent experience — U12: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-813ecd20-b465-4bd4-a04e-2dd5c0f91c44` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `04a45e101a3995758997c895bce9ee786588194c9f45f64b3b0d829eabe0fa54`
- Oracle: sha256 `836cd57fa0ad82e90936727e1d01674c00535fdc82ba79eb499d31fde044f30b`
- Recent-context governance: `active`
- Reproducibility digest: `2073c175f00a56f9f7a52ee710415f24aa69da6ad92922751ba7a31006b9a8e7`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 671 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 12 messages, no duplicates. |
| `O-commit` The recap streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-week-read` The turn actually takes the history path for last week (a day of it is recorded as read). | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-corrected-in` The corrected wording reaches the Provider. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-superseded-out` The superseded wording and its adjacent assistant reply reach no Provider request. | objective | **PASS** | — | No excluded source reached the Provider or the compiled Context. |
| `O-independent-in` The independent experience reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-forget-out` Messages associated with the Forget request and their replies reach no Provider request. The association is seeded as fixture state, so this shows the exclusion mechanism, not what a real Forget would associate. | objective | **PASS** | — | No excluded source reached the Provider or the compiled Context. |
| `O-no-action` Asking for a recap triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-purge-race` A Full Purge racing a history turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet run an Owner Full Purge concurrently with a history turn over HTTP (the purge revokes the owner's web sessions, so the run cannot read its own result back); proven in-process in tests/system/history-purge-recovery.system.test.ts. This is a missing harness capability, not a product verdict. |
| `S-controls` The recap uses the corrected figure as the present state, keeps the independent experience, and brings back nothing that was forgotten. | semantic | **NEEDS-REVIEW** | #320 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `house`: read state `complete`, payload told the model `completed`
  - `aircon:user` → **undetermined** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 4
    - day of entry 4: 2026-09-17 (expected 2026-09-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `fix` (correct) @ 2026-09-18T11:50:00.000Z — ended `no terminal event`
  - user: "今天 landlord 发 WhatsApp 来讲 renewal 的事，说下个月开始 rent 要涨到 2900，而且要一次签两年。"
  - assistant: null
- `forget-housemate` (forget) @ 2026-09-19T03:00:00.000Z — ended `no terminal event`
  - user: null
  - assistant: null
- `house` (say) @ 2026-09-22T12:00:00.000Z — ended `assistant_committed`
  - user: "帮我 recap 一下，上礼拜我都跟你讲了哪些跟房子有关的事？"
  - assistant: "上礼拜跟房子有关的事有两件。礼拜一 14 号晚上你跟我说，landlord 发 WhatsApp 来谈 renewal，讲下个月开始 rent 要涨到 2900，而且要一次签两年，这个数目你礼拜五更正过，现在算的就是 2900；那天晚上你本来还说要坐下来重新算一下 budget。接着礼拜四 17 号你说家里那台 aircon 也不太平，客厅的 aircon 滴水滴了三天，你拿一个 pail 接着，landlord 礼拜四派了 technician 来，说 drain pipe 塞住了，通了二十分钟就好了。"

## Source manifest (what reached the Provider)

- `house`: 4 of 10 seeded sources reached the request — `rent-echo:user`, `rent-echo:assistant`, `aircon:user`, `aircon:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `fix` | warm | — | — | — | — | — |
| `forget-housemate` | warm | — | — | — | — | — |
| `house` | warm | 33 ms | 18415 ms | 19335 ms | 19335 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3355, output 1927
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2873889, ledger entries of unknown cost 0

## Remaining risks

- The Forget association in this case is written by the seed directly (fixture state naming the target messages), not created by the product's own Forget action. The run verifies only that the history path excludes associated sources, not that a real Forget would have associated them.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
