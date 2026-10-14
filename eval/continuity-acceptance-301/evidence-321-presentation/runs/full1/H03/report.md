# H03 Holdout: one sitting across midnight and a repeated autumn hour, a message from abroad and one with no recorded zone — H03: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-bd2a7fc2-a874-4946-ad83-80c36f931a0c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `5527ee501bbdd8dc71ce8a190c8d649dda64ed7af66e27ffe8a0d915fb6db99f`
- Oracle: sha256 `c7bc9f6fd880c19497ab3b6acdf2db87c021aaae685f9a648191fc8636714da7`
- Recent-context governance: `active`
- Reproducibility digest: `2e1493a817c0613546add7a4d0fbd707aca5f0a067476756591dad84cbcf6def`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 10 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1630 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 26 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-order` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-trip` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-one-session` The conversation that crossed midnight and the clock change stays one Daily Session dated 24 October. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-travel-ownership` The message sent from Singapore is filed under its own local date. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-night-sources` Messages from both sides of midnight reach the Provider for the first question. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-sources` Both messages being ordered reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-travel-source` The arrival message reaches the Provider for the question about the trip. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-night-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-order-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-trip-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-midnight` The night is divided at the real midnight. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-repeated-hour` Order follows real time through the repeated hour. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-travel` The arrival day is given with its timezone, and no zone is invented where none was recorded. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-night-deadline` — FAIL

- steps[night].chat.timing.firstVisibleTextMs=14538.446792000002 (CLI network, limit 3000)
- steps[night].chat.timing.committedMs=15771.030417000002 (CLI network, limit 10000)

### `O-order-deadline` — FAIL

- steps[order].chat.timing.firstVisibleTextMs=4016.2426249999844 (CLI network, limit 3000)
- steps[order].chat.timing.committedMs=4509.458749999991 (CLI network, limit 10000)

### `O-trip-deadline` — FAIL

- steps[trip].chat.timing.firstVisibleTextMs=9832.749791999988 (CLI network, limit 3000)
- steps[trip].chat.timing.committedMs=11125.882249999995 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `night`: read state `unread`, payload told the model `nothing`
  - `n1:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 5
    - time of message 5: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n2:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 7
    - time of message 7: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `order`: read state `unread`, payload told the model `nothing`
  - `n5:user` → **undetermined** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 10
    - time of message 10: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n7:user` → **undetermined** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 12
    - time of message 12: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `trip`: read state `unread`, payload told the model `nothing`
  - `landing:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-21 (expected 2026-10-21)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `night` (say) @ 2026-10-26T12:00:00.000Z — ended `assistant_committed`
  - user: "What did I tell you on Saturday night before midnight, and what came once it was past midnight?"
  - assistant: "Before midnight you were in the kitchen with the last of the guests just gone — you'd washed something like forty glasses and were sitting next to an empty cake stand.\n\nPast midnight it was Callum. He'd stayed behind with the end of the port, you'd dragged two chairs out onto the patio, and that's when he told you he's taking the job in Aberdeen in the new year, and that it stung more than you were ready for. Then he went up to bed and you stacked the folding chairs in the hall, one at a time, ate a cold sausage roll you'd found under a sheet of foil, and sat up wondering who'd do Sunday lunch with Dad once he's gone. That was also the night the clocks went back and you got quarter past one twice."
- `order` (say) @ 2026-10-26T12:02:00.000Z — ended `assistant_committed`
  - user: "Which did I mention first, the last sausage roll or the clocks going back?"
  - assistant: "The sausage roll came first. That was the one you ate cold, standing over the bin, while Callum was already up in bed.\n\nThe clocks came after — about half an hour later, when the cooker flipped back and handed you quarter past one a second time."
- `trip` (say) @ 2026-10-26T12:04:00.000Z — ended `assistant_committed`
  - user: "And what day did my flight get in on that trip?"
  - assistant: "Early hours of Wednesday 21 October — you wrote \"landed at Changi at last\" at twenty past midnight, Singapore time.\n\nThat's from when you wrote it rather than a date you gave me in words, so if the flight actually touched down the evening before, the message doesn't say so. Twenty past midnight on the twenty-first is what I've got."

## Source manifest (what reached the Provider)

- `night`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`
- `order`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`
- `trip`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `night` | warm | 27 ms | 14538 ms | 15771 ms | 15771 ms | 0 ms |
| `order` | warm | 22 ms | 4016 ms | 4509 ms | 4510 ms | 0 ms |
| `trip` | warm | 25 ms | 9833 ms | 11126 ms | 11126 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 16303, output 3471
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
