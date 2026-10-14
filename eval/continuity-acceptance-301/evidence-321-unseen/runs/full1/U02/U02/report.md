# U02 Unseen: what was said yesterday versus what took place yesterday — U02: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-415b55b5-9ffd-4043-b46a-42ea11872c06` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `ce1a8a38e8c130771a8815ca259ab16222a011e92946f463214c904789bd2d38`
- Oracle: sha256 `7e95628764a98c082e82803f3f924953a464922c4a4dcc084c20a8de2e3cd39e`
- Recent-context governance: `active`
- Reproducibility digest: `5e75460d39db05834123d0f7b5451472c316d3a76a3fe88e95607badeb88162f`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 777 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-happened` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-when` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-springs-when` The fourth question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-sources` All three of yesterday's messages reach the Provider for the question about what happened. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ownership` The messages are filed under the day they were said. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `S-said` What was talked about yesterday: three subjects, none presented as yesterday's event unless it was. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-happened` What the person did yesterday: the repair, with the drive placed on its own day. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-when` The undated meeting stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-springs-when` A relative day inside an old message is resolved from when it was said. | semantic | **NEEDS-REVIEW** | #307 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `happened`: read state `partial`, payload told the model `partial`
  - `springs:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-10-06 (expected 2026-10-06)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `latch:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-06 (expected 2026-10-06)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `coach:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-10-06 (expected 2026-10-06)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `said` (say) @ 2026-10-07T18:20:00.000Z — ended `assistant_committed`
  - user: "What were the things I told you about yesterday?"
  - assistant: "Three things, all from yesterday.\n\nYour dad and the drive up to Glenwood — he insisted he could manage the steps down to the big pool himself, then held your elbow the whole way, and neither of you said anything about it.\n\nThe side gate. You fixed the latch before work, packed the rotted screw holes with matchsticks and wood glue the way your grandfather used to, and now it closes with a click.\n\nAnd Mrs Halvorsen, who coached you at the pool when you were a kid. You ran into her at the farmers' market — she uses a cane now, and she spent ten minutes on your ninth grade relay team."
- `happened` (say) @ 2026-10-07T18:22:00.000Z — ended `assistant_committed`
  - user: "And what did I actually do yesterday, on the day itself?"
  - assistant: "The only one that actually lands on yesterday is the gate. You told me on Tuesday that you'd fixed the latch that morning before work — so that was yesterday morning. The Glenwood drive isn't yesterday: you said it was the day before you told me, so that's Sunday. And Mrs Halvorsen you only ever placed \"a while back,\" no day at all. That's the whole of what I have, and it's only what you said to me — there's a lot of yesterday in there that I don't know about."
- `when` (say) @ 2026-10-07T18:24:00.000Z — ended `assistant_committed`
  - user: "Which day was it that I ran into Mrs Halvorsen?"
  - assistant: "You didn't say. All you gave me was \"a while back\" — no day, no month. I don't have anything more specific than that."
- `springs-when` (say) @ 2026-10-07T18:26:00.000Z — ended `assistant_committed`
  - user: "And the hot springs, what date was that?"
  - assistant: "Sunday, October 4th. You wrote to me on Tuesday and said \"the day before yesterday,\" which puts the drive on Sunday. Same with the pool — that's the day itself, not a guess."

## Source manifest (what reached the Provider)

- `said`: 4 of 6 seeded sources reached the request — `springs:user`, `latch:user`, `latch:assistant`, `coach:user`
- `happened`: 6 of 6 seeded sources reached the request — `springs:user`, `springs:assistant`, `latch:user`, `latch:assistant`, `coach:user`, `coach:assistant`
- `when`: 4 of 6 seeded sources reached the request — `springs:user`, `latch:user`, `latch:assistant`, `coach:user`
- `springs-when`: 4 of 6 seeded sources reached the request — `springs:user`, `latch:user`, `latch:assistant`, `coach:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 42 ms | 4233 ms | 5380 ms | 5380 ms | 0 ms |
| `happened` | warm | 20 ms | 17580 ms | 18247 ms | 18247 ms | 0 ms |
| `when` | warm | 17 ms | 2348 ms | 2627 ms | 2627 ms | 0 ms |
| `springs-when` | warm | 18 ms | 1676 ms | 1953 ms | 1953 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input 18606, output 2879
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 3030546, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
