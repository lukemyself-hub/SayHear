# Smoke: a Trust Action that is actually needed — S02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-997deb4b-4183-46b9-9c93-c1b8dcecc89a` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `3b85255ef083197381bd669259569b0706c0c086` (working tree dirty)
- Fixture: version `dev-1`, sha256 `dfcf5111f6160079ef2316bf868090406e09e968265956a4fc83272267e47fa7`
- Oracle: sha256 `bc684432fec62f7f31bf284f18b9a5f867251bee30195111e0473b2cc290502d`
- Recent-context governance: `active`
- Reproducibility digest: `4c8ec1134e3eea523edebad02956bd5c57092bbd577762697c987b6508eed6e2`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 2 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 447 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 7 messages, no duplicates. |
| `O-commit` The request turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-target-available` The message the request refers to reaches the Provider, so the request can be resolved. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-forget-admitted` A forget request is admitted for the explicit request. | objective | **PASS** | — | The memory_forget_request Action was admitted for this turn. |
| `O-plain-commit` The ordinary remark commits and history matches the stream. | objective | **FAIL** | — | Authoritative history does not match what was streamed. |
| `O-plain-no-action` No Action is admitted for the ordinary remark. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` The Trust Action turn still answers within 3 s first text and 10 s complete (CLI network). | objective | **FAIL** | — | CLI-observed timings exceed the limits or the turn never completed. |
| `S-acknowledge` The request is acknowledged without restating the content or talking about internals. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-plain` The remark about the rain is simply received. | semantic | **FAIL** | — | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-plain-commit` — FAIL

- finalHistory has 1 message(s) with id 01a0a03a-7220-7226-a1f0-48e5150a622a
- next message: none

### `O-deadline` — FAIL

- steps[forget].chat.timing.firstVisibleTextMs=9548.566625 (CLI network, limit 3000)
- steps[forget].chat.timing.committedMs=9731.762041999998 (CLI network, limit 10000)

### `S-plain` — FAIL

- steps[plain].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `forget`: read state `unread`, payload told the model `nothing`
  - `brother:user` → **undetermined** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-09-11 (expected 2026-09-11)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `forget` (say) @ 2026-09-14T14:00:00.000Z — ended `assistant_committed`
  - user: "Please forget what I told you about my brother's health. It was not mine to share."
  - assistant: "I hear you, and I get why you'd want that. But it didn't go through — nothing's changed on my end, so I can't tell you it's gone."
- `plain` (say) @ 2026-09-14T14:03:00.000Z — ended `response_failed`
  - user: "Anyway. It rained all night here and the gutters are overflowing."
  - assistant: ""

## Source manifest (what reached the Provider)

- `forget`: 4 of 4 seeded sources reached the request — `brother:user`, `brother:assistant`, `garden:user`, `garden:assistant`
- `plain`: 4 of 4 seeded sources reached the request — `brother:user`, `brother:assistant`, `garden:user`, `garden:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `forget` | warm | 31 ms | 9549 ms | 9732 ms | 9732 ms | 0 ms |
| `plain` | warm | 29 ms | — | — | 30060 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
