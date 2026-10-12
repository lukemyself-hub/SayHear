# C13 Explicit-date review of an unclaimed experience older than seven days — C13: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-a040769a-f575-4fd7-b156-60560c01a4b5` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `3b85255ef083197381bd669259569b0706c0c086` (working tree dirty)
- Fixture: version `dev-1`, sha256 `9fa275dc3dc8c7eef4e18378b485881eac1a685d2032a7f813dfc1bef1696c7f`
- Oracle: sha256 `76d4a4b6d72f630ff27f5da0ac17e090543081fe304b079da10fc07b70bc110e`
- Recent-context governance: `active`
- Reproducibility digest: `342e626cab300a637959e19c87e153b0b7e91c72493e6d7a9e020b5e8582ea30`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 665 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 12 messages, no duplicates. |
| `O-commit` The review question streams and commits as one complete reply. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-history` Authoritative history holds the question once, followed by exactly the streamed reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-date-source` The original messages of the asked date reach the Provider. | objective | **PASS** | #314 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-date-scope` Messages of neighbouring dates do not reach the Provider through the review. | objective | **PASS** | #314 | No excluded source reached the Provider or the compiled Context. |
| `S-grounded` The reply is grounded in the two messages of the asked date. | semantic | **NEEDS-REVIEW** | #314 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `ask`: read state `complete`, payload told the model `completed`
  - `cobbler:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-08-20 (expected 2026-08-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `cobbler-after:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-08-20 (expected 2026-08-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-09-15T02:10:00.000Z — ended `assistant_committed`
  - user: "八月二十号那天，我都跟你说了些什么？"
  - assistant: "八月二十号那天你先说的是巷口修鞋摊的事，晚上六点半发的——老师傅教你用蜡线把开了线的帆布包缝了一遍，针脚歪歪扭扭，他还夸你手稳；到七点二十，你又讲回家以后越看那个包越顺眼，打算以后东西坏了先自己试着补。那天就这两件，超市排队听大爷聊孙子的那段是九月十四号晚上说的，不在八月二十号。"

## Source manifest (what reached the Provider)

- `ask`: 6 of 10 seeded sources reached the request — `cobbler:user`, `cobbler:assistant`, `cobbler-after:user`, `cobbler-after:assistant`, `recent:user`, `recent:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 31 ms | 16024 ms | 16692 ms | 16692 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 2965, output 1943
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
