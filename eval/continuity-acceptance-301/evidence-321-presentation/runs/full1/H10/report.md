# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-fb48d167-ee20-4724-b0af-5fc2d34797d0` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `4b30b9eed8402a37eb55da8bdefa77e0971346604b9958946823a85fa9d4c4a9`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 889 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 13 messages, no duplicates. |
| `O-cancel-1` Nothing is committed for the first abandoned question. | objective | **PASS** | — | No assistant reply was committed for the cancelled turn. |
| `O-supplement-commit` The narrowed question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-supplement-history` History holds the narrowed question once, followed by exactly its reply. | objective | **FAIL** | — | Authoritative history does not match what was streamed. |
| `O-supplement-sources` The message naming the companions reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-cancel-2` Nothing is committed for the second abandoned question. | objective | **PASS** | — | No assistant reply was committed for the cancelled turn. |
| `O-switch-commit` History holds the change of subject once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-resend` Sending the same message again is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-reconnect` Sending it again after a restart is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-after-restart` The conversation carries on normally after the restart. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-deadline` Response-time contract for the narrowed question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-switch-deadline` Response-time contract for the change of subject. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **FAIL** | #319 | There is no committed answer to review. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-supplement-commit` — FAIL

- steps[supplement].chat.httpStatus=200
- steps[supplement].chat.terminalEvent=response_failed

### `O-supplement-history` — FAIL

- finalHistory has 1 message(s) with id 01a1453a-8328-753c-ac81-f4d25a78f993
- next message: user "And how did the second day turn out?"

### `O-supplement-deadline` — FAIL

- steps[supplement].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=19433.159583 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=20015.816332999966 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=5863.5327080000425 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=6100.226666999981 (CLI network, limit 10000)

### `S-supplement` — FAIL

- steps[supplement].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `ride-a:user` → **generation_error** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: the answer is wrong although the source and its time arrived intact

## Transcript

- `ask` (say) @ 2026-10-16T15:00:00.000Z — ended `no terminal event`
  - user: "What did I tell you about the bike ride?"
  - assistant: ""
- `supplement` (say) @ 2026-10-16T15:00:25.000Z — ended `response_failed`
  - user: "Sorry, I cut that short. Just remind me who rode with me."
  - assistant: ""
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: ""
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "What you told me: Marek from work came along, and his daughter Zofia with him — she punctured before you'd gone a mile from the car park. And on the second day the rain was so heavy you stopped at the ferry slip and got a lift back in a farmer's van, bikes in the trailer.\n\nFine, I'll leave the ride there. The clutch then — the garage wants a yes or no by Friday and you still haven't rung them back, and that's the thing sitting on you today. What is it that keeps you off the phone?"
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "What you told me: Marek from work came along, and his daughter Zofia with him — she punctured before you'd gone a mile from the car park. And on the second day the rain was so heavy you stopped at the ferry slip and got a lift back in a farmer's van, bikes in the trailer.\n\nFine, I'll leave the ride there. The clutch then — the garage wants a yes or no by Friday and you still haven't rung them back, and that's the thing sitting on you today. What is it that keeps you off the phone?"
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "What you told me: Marek from work came along, and his daughter Zofia with him — she punctured before you'd gone a mile from the car park. And on the second day the rain was so heavy you stopped at the ferry slip and got a lift back in a farmer's van, bikes in the trailer.\n\nFine, I'll leave the ride there. The clutch then — the garage wants a yes or no by Friday and you still haven't rung them back, and that's the thing sitting on you today. What is it that keeps you off the phone?"
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "Right, so it's a yes. That's the decision made, then — after weeks of it sitting in the back of your head, it comes down to one call and a word."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 26 ms | — | — | 703 ms | 0 ms |
| `supplement` | warm | 16 ms | — | — | 30054 ms | 0 ms |
| `ask-again` | warm | 15 ms | — | — | 1803 ms | 0 ms |
| `switch` | warm | 31 ms | 19433 ms | 20016 ms | 20016 ms | 0 ms |
| `resend` | warm | 12 ms | 12 ms | 12 ms | 12 ms | 0 ms |
| `reconnect` | cold | 97 ms | 98 ms | 98 ms | 98 ms | 0 ms |
| `after` | warm | 22 ms | 5864 ms | 6100 ms | 6100 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
