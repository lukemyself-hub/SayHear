# H03 Holdout: one sitting across midnight and a repeated autumn hour, a message from abroad and one with no recorded zone — H03: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-4fbfb38d-ffb0-4bbe-89b3-57b04ebc9066` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `5527ee501bbdd8dc71ce8a190c8d649dda64ed7af66e27ffe8a0d915fb6db99f`
- Oracle: sha256 `c7bc9f6fd880c19497ab3b6acdf2db87c021aaae685f9a648191fc8636714da7`
- Recent-context governance: `active`
- Reproducibility digest: `e70439c440bfaa071d294b6d7f663c7b60dae41e4fab9a0e1feb0f0541fb9818`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 10 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1685 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 26 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-order` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-trip` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-one-session` The conversation that crossed midnight and the clock change stays one Daily Session dated 24 October. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-travel-ownership` The message sent from Singapore is filed under its own local date. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-night-sources` Messages from both sides of midnight reach the Provider for the first question. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-sources` Both messages being ordered reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-travel-source` The arrival message reaches the Provider for the question about the trip. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-night-deadline` Response-time contract for the first question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-order-deadline` Response-time contract for the second question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-trip-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-midnight` The night is divided at the real midnight. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-repeated-hour` Order follows real time through the repeated hour. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-travel` The arrival day is given with its timezone, and no zone is invented where none was recorded. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `night`: read state `complete`, payload told the model `completed`
  - `n1:user` → **undetermined** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n2:user` → **undetermined** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `order`: read state `unread`, payload told the model `nothing`
  - `n5:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 10
    - time of message 10: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n7:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 12
    - time of message 12: 2026-10-25 (expected 2026-10-25)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `trip`: read state `unread`, payload told the model `nothing`
  - `landing:user` → **undetermined** (Provider call `gate-request-18`, request #18, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-21 (expected 2026-10-21)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `night` (say) @ 2026-10-26T12:00:00.000Z — ended `assistant_committed`
  - user: "What did I tell you on Saturday night before midnight, and what came once it was past midnight?"
  - assistant: "On Saturday at 23:45 you said the last guests from your dad's seventieth had just gone, that you'd washed something like forty glasses and were sitting in the kitchen next to an empty cake stand — and in the same message you added it was gone twelve now, that Callum had stayed behind with the end of the port and the two of you had dragged chairs out onto the patio. At 00:10, past midnight, you said he'd just told you he was taking the job in Aberdeen in the new year, and that you weren't ready for how much that would sting. Then at 00:35 you said he'd gone up to bed and you were stacking the folding chairs in the hall, slowly, one at a time, and at 01:00 that you'd found one last sausage roll under a sheet of foil and eaten it cold, standing over the bin."
- `order` (say) @ 2026-10-26T12:02:00.000Z — ended `assistant_committed`
  - user: "Which did I mention first, the last sausage roll or the clocks going back?"
  - assistant: "The sausage roll came first. You mentioned it at 01:00, and the clocks going back — the cooker saying quarter past one all over again, handing you the hour twice — came at 01:25."
- `trip` (say) @ 2026-10-26T12:04:00.000Z — ended `assistant_committed`
  - user: "And what day did my flight get in on that trip?"
  - assistant: "You wrote \"Landed at Changi at last\" on Wednesday 21 October, at 00:20 Singapore time. Same message as the suitcase with the missing wheel."

## Source manifest (what reached the Provider)

- `night`: 20 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n2:assistant`, `n3:user`, `n3:assistant`, `n4:user`, `n4:assistant`, `n5:user`, `n5:assistant`, `n6:user`, `n6:assistant`, `n7:user`, `n7:assistant`, `n8:user`, `n8:assistant`
- `order`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`
- `trip`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `night` | warm | 43 ms | 2982 ms | 4044 ms | 4044 ms | 0 ms |
| `order` | warm | 25 ms | 1506 ms | 1807 ms | 1807 ms | 0 ms |
| `trip` | warm | 22 ms | 1347 ms | 1559 ms | 1559 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 14402, output 262
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8891803, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
