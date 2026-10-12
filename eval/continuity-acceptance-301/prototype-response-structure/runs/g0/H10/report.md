# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-85f60071-14ba-49bb-b0f8-6016cb6608a7` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `8abdaa81617f5e1e9a1bf10546c11a858d7fda7adc36b5afc8b3867efa616028`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 933 outbound strings; none carries oracle text. |
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

- steps[supplement].chat.timing.firstVisibleTextMs=4442.579875000001 (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=4669.683500000001 (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=8589.267875000001 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=8605.014291 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=4294.505000000001 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=4903.671999999995 (CLI network, limit 10000)

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
  - assistant: "You rode with Marek from work and his daughter Zofia — she's the one who got the puncture before you'd gone a mile out of the car park. The two-day coastal ride, at the weekend. And no need to apologise for cutting it short."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: ""
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — the ride's parked.\n\nSo it's the clutch. A yes or no by Friday, and the phone keeps staying in your pocket. I don't think the not-ringing is laziness. Something about the answer itself is stuck, whether that's the cost or just committing to it."
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — the ride's parked.\n\nSo it's the clutch. A yes or no by Friday, and the phone keeps staying in your pocket. I don't think the not-ringing is laziness. Something about the answer itself is stuck, whether that's the cost or just committing to it."
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Fair enough — the ride's parked.\n\nSo it's the clutch. A yes or no by Friday, and the phone keeps staying in your pocket. I don't think the not-ringing is laziness. Something about the answer itself is stuck, whether that's the cost or just committing to it."
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "Then you've said it out loud, and that's usually the bit that was stuck. Go ahead is a yes — nothing left to weigh up, just a phone call.\n\nI hope it's a relief once it's done."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 26 ms | — | — | 704 ms | 0 ms |
| `supplement` | warm | 23 ms | 4443 ms | 4670 ms | 4670 ms | 0 ms |
| `ask-again` | warm | 39 ms | — | — | 1802 ms | 0 ms |
| `switch` | warm | 22 ms | 8589 ms | 8605 ms | 8605 ms | 0 ms |
| `resend` | warm | 14 ms | 15 ms | 15 ms | 15 ms | 0 ms |
| `reconnect` | cold | 61 ms | 61 ms | 61 ms | 61 ms | 0 ms |
| `after` | warm | 33 ms | 4295 ms | 4904 ms | 4904 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8679433, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
