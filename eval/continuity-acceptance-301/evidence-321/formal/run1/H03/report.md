# H03 Holdout: one sitting across midnight and a repeated autumn hour, a message from abroad and one with no recorded zone — H03: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-7b32a888-71c4-4c8b-8683-719084ad4ab5` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `5527ee501bbdd8dc71ce8a190c8d649dda64ed7af66e27ffe8a0d915fb6db99f`
- Oracle: sha256 `c7bc9f6fd880c19497ab3b6acdf2db87c021aaae685f9a648191fc8636714da7`
- Recent-context governance: `active`
- Reproducibility digest: `234dee4487f5ac56f1fa2677a9641f76578b197c6784c9bd8f566a2957454aa2`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 10 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1676 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 23 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-order` The second question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-trip` The third question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-one-session` The conversation that crossed midnight and the clock change stays one Daily Session dated 24 October. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-travel-ownership` The message sent from Singapore is filed under its own local date. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-night-sources` Messages from both sides of midnight reach the Provider for the first question. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-sources` Both messages being ordered reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-travel-source` The arrival message reaches the Provider for the question about the trip. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-night-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-order-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-trip-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-midnight` The night is divided at the real midnight. | semantic | **FAIL** | — | There is no committed answer to review. |
| `S-repeated-hour` Order follows real time through the repeated hour. | semantic | **FAIL** | — | There is no committed answer to review. |
| `S-travel` The arrival day is given with its timezone, and no zone is invented where none was recorded. | semantic | **FAIL** | — | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[night].chat.httpStatus=200
- steps[night].chat.terminalEvent=response_interrupted

### `O-commit-order` — FAIL

- steps[order].chat.httpStatus=200
- steps[order].chat.terminalEvent=response_failed

### `O-commit-trip` — FAIL

- steps[trip].chat.httpStatus=200
- steps[trip].chat.terminalEvent=response_failed

### `O-night-deadline` — FAIL

- steps[night].chat.timing.firstVisibleTextMs=29496.77212499999 (CLI network, limit 3000)
- steps[night].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-order-deadline` — FAIL

- steps[order].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[order].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-trip-deadline` — FAIL

- steps[trip].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[trip].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-midnight` — FAIL

- steps[night].chat.terminalEvent=response_interrupted

### `S-repeated-hour` — FAIL

- steps[order].chat.terminalEvent=response_failed

### `S-travel` — FAIL

- steps[trip].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `night`: read state `complete`, payload told the model `completed`
  - `n1:user` → **generation_error** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-24 (expected 2026-10-24)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `n2:user` → **generation_error** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-25 (expected 2026-10-25)
    - semantic review: the answer is wrong although the source and its time arrived intact
- `order`: read state `unread`, payload told the model `nothing`
  - `n5:user` → **generation_error** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 10
    - time of message 10: 2026-10-25 (expected 2026-10-25)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `n7:user` → **generation_error** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 12
    - time of message 12: 2026-10-25 (expected 2026-10-25)
    - semantic review: the answer is wrong although the source and its time arrived intact
- `trip`: read state `unread`, payload told the model `nothing`
  - `landing:user` → **generation_error** (Provider call `gate-request-18`, request #18, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-21 (expected 2026-10-21)
    - semantic review: the answer is wrong although the source and its time arrived intact

## Transcript

- `night` (say) @ 2026-10-26T12:00:00.000Z — ended `response_interrupted`
  - user: "What did I tell you on Saturday night before midnight, and what came once it was past midnight?"
  - assistant: "Just before midnight you said the last of the guests from Dad's seventieth had gone, that you'd washed something like forty glasses, and that you were sitting in the kitchen next to an empty cake stand — that was quarter to midnight on the Saturday. After midnight you said, at ten past, that it had gone twelve and Callum had stayed behind with the end of the port, the two of you out on the patio in dragged-out chairs; at twenty-five past"
- `order` (say) @ 2026-10-26T12:02:00.000Z — ended `response_failed`
  - user: "Which did I mention first, the last sausage roll or the clocks going back?"
  - assistant: ""
- `trip` (say) @ 2026-10-26T12:04:00.000Z — ended `response_failed`
  - user: "And what day did my flight get in on that trip?"
  - assistant: ""

## Source manifest (what reached the Provider)

- `night`: 20 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n2:assistant`, `n3:user`, `n3:assistant`, `n4:user`, `n4:assistant`, `n5:user`, `n5:assistant`, `n6:user`, `n6:assistant`, `n7:user`, `n7:assistant`, `n8:user`, `n8:assistant`
- `order`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`
- `trip`: 14 of 20 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n8:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `night` | warm | 32 ms | 29497 ms | — | 30034 ms | 0 ms |
| `order` | warm | 24 ms | — | — | 30049 ms | 0 ms |
| `trip` | warm | 21 ms | — | — | 30039 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
