# HL1 Holdout: typing on while a reply is prepared, and a Provider that never answers, at the product's own 30 second budget — HL1: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-fd53c5bd-85e4-431d-8327-c1b7439fe870` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `5bd7013d8eb5d70eeb95c280801eb9d024d44f504f6e0fe2171dcbab156341a1`
- Oracle: sha256 `d0c5bcd200a45b03dd3bec51a575dc78e206d1ce7c233e317742c4dea0d21523`
- Recent-context governance: `active`
- Reproducibility digest: `b84b34b858767eaaccdda5a33a5d3a883fa6c8f086af5975d1f15f0198784636`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 2 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 647 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 11 messages, no duplicates. |
| `O-replaced-never-shown` The reply to the replaced question is neither shown nor stored. | objective | **PASS** | #319 | The retired reply was neither shown nor stored. |
| `O-addition-commits` History holds the addition once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-addition-keeps-earlier-question` The replaced question still reaches the Provider with the addition. | objective | **PASS** | #319 | Everything said earlier in the run reached the Provider for this turn. |
| `O-addition-sources` The message naming the companion reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-stall-stops` With the product's own budget, a request whose Provider never answers ends with a timeout by 30 seconds (31 allowed for the client to see it), commits nothing late and leaves nothing running. | objective | **FAIL** | #319 | The stalled request was not stopped with a timeout inside the limit. |
| `O-after-stall` The next message is answered normally. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-deadline` Response-time contract for the addition. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-after-deadline` Response-time contract for the message after the stall. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-addition` The addition is answered as asked, in ordinary words. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-stall-stops` — FAIL

- steps[stall].chat last event=assistant_committed category=none
- steps[stall].chat.timing.streamClosedMs=45943.772375 (CLI network, limit 31000)
- steps[stall].inspection.commandStatus=succeeded attemptStatus=succeeded
- message following 01a13636-bf40-7a62-b3cc-db8c4686651a: assistant

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `fair:user` → **undetermined** (Provider call `gate-request-5`, request #5, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-10 (expected 2026-10-10)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-13T17:00:00.000Z — ended `response_failed`
  - user: "What did I tell you about the fall fair?"
  - assistant: ""
- `supplement` (say) @ 2026-10-13T17:00:08.000Z — ended `assistant_committed`
  - user: "Actually, all I want to know is who I went with."
  - assistant: "You went with your nephew Theo. You took him today and shared a paper cone of mini donuts on the bleachers by the tractor pull."
- `stall` (say) @ 2026-10-13T17:02:00.000Z — ended `assistant_committed`
  - user: "And what was it we said about the canoe?"
  - assistant: "You talked about it on the drive home: renting a canoe at Alouette Lake before it gets too cold, the way your uncle used to take you."
- `after` (say) @ 2026-10-13T17:04:00.000Z — ended `assistant_committed`
  - user: "Never mind that. Is it too late in the year to plan the lake trip?"
  - assistant: "Not something I can answer for you — the weather and the lake's season are real-world facts I don't have, and I won't guess at them. What I do know is what you said: you want to get the canoe rented before it turns cold."

## Source manifest (what reached the Provider)

- `ask`: 3 of 4 seeded sources reached the request — `fair:user`, `fair:assistant`, `canoe:user`
- `supplement`: 3 of 4 seeded sources reached the request — `fair:user`, `fair:assistant`, `canoe:user`
- `stall`: 3 of 4 seeded sources reached the request — `fair:user`, `fair:assistant`, `canoe:user`
- `after`: 3 of 4 seeded sources reached the request — `fair:user`, `fair:assistant`, `canoe:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 41 ms | — | — | 743 ms | 8000 ms |
| `supplement` | warm | 35 ms | 996 ms | 1279 ms | 1279 ms | 0 ms |
| `stall` | warm | 17 ms | 45744 ms | 45944 ms | 45944 ms | 0 ms |
| `after` | warm | 28 ms | 634 ms | 980 ms | 980 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8026000, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
