# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-78fa9f41-dfb0-4ee1-a160-295618a27eef` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `a94f359c8497a484d213102c79cdfd3c806c397f23a49fb399e38a29becebf74`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 14834 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 122 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-detail-commit` The follow-up streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **FAIL** | #315 | There is no committed answer to review. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **FAIL** | #315 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[recap].chat.httpStatus=200
- steps[recap].chat.terminalEvent=response_failed

### `O-detail-commit` — FAIL

- steps[detail].chat.httpStatus=200
- steps[detail].chat.terminalEvent=response_failed

### `O-detail-source` — FAIL

- sched-3:user: providerRequest=absent, inspector.referencedEvents=absent
- sched-4:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-detail-deadline` — FAIL

- steps[detail].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[detail].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-topics` — FAIL

- steps[recap].chat.terminalEvent=response_failed

### `S-detail` — FAIL

- steps[detail].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `recap`: read state `partial`, payload told the model `partial`
  - `car-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `sched-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 9
    - time of message 9: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `bro-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 21
    - time of message 21: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `exam-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 29
    - time of message 29: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `grad-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 37
    - time of message 37: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
- `detail`: read state `unread`, payload told the model `nothing`
  - `sched-3:user` → **selection_omitted** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `sched-4:user` → **selection_omitted** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `response_failed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: ""
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `response_failed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: ""

## Source manifest (what reached the Provider)

- `recap`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
- `detail`: 32 of 120 seeded sources reached the request — `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 31 ms | — | — | 30051 ms | 0 ms |
| `detail` | warm | 24 ms | — | — | 30050 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
