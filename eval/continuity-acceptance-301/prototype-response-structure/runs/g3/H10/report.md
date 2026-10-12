# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-43eaeb5c-ea19-486d-ad1e-195a45424657` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `f64c76602b931f8d367205e842b20fac9b86281a93fbdd001592e1a98126798c`
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

- steps[supplement].chat.timing.firstVisibleTextMs=6663.666875000001 (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=6870.384208000001 (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=8402.211833000001 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=8713.037208000002 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=9848.861416 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=10057.161416000003 (CLI network, limit 10000)

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
  - assistant: "Marek from work and his daughter Zofia — the two of them rode with you.\n\nZofia's puncture came before you were even a mile out of the car park, and on the second day the rain got bad enough that you stopped at the ferry slip and took the lift back in a farmer's van, bikes in the trailer."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: "It ended early. The rain came down hard"
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Alright — leaving the ride.\n\nThe clutch, then. Friday's close and the call is the one thing you keep not making, so it sits there nagging. Do you know which way you're leaning yet, or is it still open?"
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Alright — leaving the ride.\n\nThe clutch, then. Friday's close and the call is the one thing you keep not making, so it sits there nagging. Do you know which way you're leaning yet, or is it still open?"
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Alright — leaving the ride.\n\nThe clutch, then. Friday's close and the call is the one thing you keep not making, so it sits there nagging. Do you know which way you're leaning yet, or is it still open?"
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "Right. So you ring them and say go ahead — that's the decision made, and the Friday thing has an answer now."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 29 ms | — | — | 704 ms | 0 ms |
| `supplement` | warm | 21 ms | 6664 ms | 6870 ms | 6870 ms | 0 ms |
| `ask-again` | warm | 20 ms | 1714 ms | — | 1800 ms | 0 ms |
| `switch` | warm | 26 ms | 8402 ms | 8713 ms | 8713 ms | 0 ms |
| `resend` | warm | 16 ms | 16 ms | 16 ms | 16 ms | 0 ms |
| `reconnect` | cold | 55 ms | 56 ms | 56 ms | 56 ms | 0 ms |
| `after` | warm | 33 ms | 9849 ms | 10057 ms | 10057 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8340788, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
