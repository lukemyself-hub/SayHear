# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-f491e675-fdaa-4b52-a930-f0d7fbce6a37` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `e2bd28f991cc090836e7a7e2c66940ce346e0d23` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `834bf503879d416be422d0dadca97b31c3d7a95456f2152d8f6f660d76d87959`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 898 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-cancel-1` Nothing is committed for the first abandoned question. | objective | **PASS** | — | No assistant reply was committed for the cancelled turn. |
| `O-supplement-commit` The narrowed question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-supplement-history` History holds the narrowed question once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-sources` The message naming the companions reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-cancel-2` Nothing is committed for the second abandoned question. | objective | **PASS** | — | No assistant reply was committed for the cancelled turn. |
| `O-switch-commit` History holds the change of subject once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-resend` Sending the same message again is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-reconnect` Sending it again after a restart is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-after-restart` The conversation carries on normally after the restart. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-deadline` Response-time contract for the narrowed question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-switch-deadline` Response-time contract for the change of subject. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-supplement-deadline` — FAIL

- steps[supplement].chat.timing.firstVisibleTextMs=4844.73562500003 (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=5173.318708000006 (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=7949.1475419999915 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=8500.622417000006 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=11238.639958000043 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=11545.737458000018 (CLI network, limit 10000)

### `S-switch` — NEEDS-REVIEW

- owner ruling (R3, Luke 2026-10-12): Answering the previous, unanswered question first and then staying with the new subject is acceptable.

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `ride-a:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-16T15:00:00.000Z — ended `no terminal event`
  - user: "What did I tell you about the bike ride?"
  - assistant: ""
- `supplement` (say) @ 2026-10-16T15:00:25.000Z — ended `assistant_committed`
  - user: "Sorry, I cut that short. Just remind me who rode with me."
  - assistant: "Marek from work and his daughter Zofia — the two-day coastal ride. Zofia was the one with the puncture before you were a mile out of the car park, and on the second day the rain had you giving up at the ferry slip and loading the bikes into a farmer's van."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: ""
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — leaving the ride.\n\nThe clutch thing has been sitting since Wednesday, and today is the Friday they gave you. That's a deadline that's arrived rather than one you're waiting on.\n\nYou've not rung them back, which tells me something's not settled. What's the part that stops you picking up the phone?"
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — leaving the ride.\n\nThe clutch thing has been sitting since Wednesday, and today is the Friday they gave you. That's a deadline that's arrived rather than one you're waiting on.\n\nYou've not rung them back, which tells me something's not settled. What's the part that stops you picking up the phone?"
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — leaving the ride.\n\nThe clutch thing has been sitting since Wednesday, and today is the Friday they gave you. That's a deadline that's arrived rather than one you're waiting on.\n\nYou've not rung them back, which tells me something's not settled. What's the part that stops you picking up the phone?"
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "That's a plain yes, then. After two days of not ringing back, it came out on its own — that reads more like the answer settling in you than you forcing it.\n\nWhatever they say on the other end of the phone, you'll know where you stand."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 27 ms | — | — | 702 ms | 0 ms |
| `supplement` | warm | 15 ms | 4845 ms | 5173 ms | 5173 ms | 0 ms |
| `ask-again` | warm | 14 ms | — | — | 1801 ms | 0 ms |
| `switch` | warm | 19 ms | 7949 ms | 8501 ms | 8501 ms | 0 ms |
| `resend` | warm | 29 ms | 30 ms | 30 ms | 30 ms | 0 ms |
| `reconnect` | cold | 79 ms | 81 ms | 81 ms | 81 ms | 0 ms |
| `after` | warm | 27 ms | 11239 ms | 11546 ms | 11546 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 5398563, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
