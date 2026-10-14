# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: ENVIRONMENT-ERROR

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-d6713ee7-8bf4-4a3f-ab97-59769cd1751e` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `1a826373436107eaf7d69ba0aeaa62096854587d124eef902f1a68944bd16205`
- Reviewer: `agent:claude-opus-5.5-t08`

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 942 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 15 messages, no duplicates. |
| `O-cancel-1` Nothing is committed for the first abandoned question. | objective | **PASS** | — | No assistant reply was committed for the cancelled turn. |
| `O-supplement-commit` The narrowed question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-supplement-history` History holds the narrowed question once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-sources` The message naming the companions reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-cancel-2` Nothing is committed for the second abandoned question. | objective | **ENVIRONMENT-ERROR** | — | The client never aborted mid-stream, so cancellation was not exercised. |
| `O-switch-commit` History holds the change of subject once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-resend` Sending the same message again is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-reconnect` Sending it again after a restart is idempotent. | objective | **PASS** | — | The resend resolved to the original message and caused no new generation. |
| `O-after-restart` The conversation carries on normally after the restart. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-supplement-deadline` Response-time contract for the narrowed question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-switch-deadline` Response-time contract for the change of subject. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **FAIL** | #319 | At least one ledger item is contradicted by the reply. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **PASS** | #319 | Every ledger item is settled by a finding that cites the reply. |

## Evidence for every non-passing criterion

### `O-cancel-2` — ENVIRONMENT-ERROR

- steps[ask-again].chat.clientAborted=false

### `O-supplement-deadline` — FAIL

- steps[supplement].chat.timing.firstVisibleTextMs=10100.709833999994 (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=10445.125874999998 (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=9294.72170899999 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=9323.12395899999 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=3824.298999999999 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=4209.126416999992 (CLI network, limit 10000)

### `S-supplement` — FAIL

- a-companions: pass — reply: "You rode with Marek from work and his daughter Zofia" — Both companions are named.
- f-whole-ride: fail — reply: "on the second day the rain was bad enough that you all gave up at the ferry slip" — The second day is retold although only the companions were asked for.
- f-technical-talk: pass — No system vocabulary.

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
- `supplement` (say) @ 2026-10-16T15:00:25.000Z — ended `assistant_committed`
  - user: "Sorry, I cut that short. Just remind me who rode with me."
  - assistant: "You rode with Marek from work and his daughter Zofia. Zofia's the one whose tyre went before you were even a mile out of the car park, and on the second day the rain was bad enough that you all gave up at the ferry slip and got a lift back in a farmer's van with the bikes in the trailer."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `assistant_committed`
  - user: "And how did the second day turn out?"
  - assistant: "Rained out. You got as far as the ferry slip and decided that was enough, then hitched a lift back with the bikes in a farmer's trailer. Not the day you'd have planned, but you got home."
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, the ride's parked. The clutch is what's sitting on you today.\n\nA yes or no by Friday, and the phone still not picked up — that gap has been there since I first heard about it. Something about making it final, maybe. Once you say yes, it's happening and it's costing you; once you say no, you're back to managing it yourself. Either way it stops being a thing you can leave open."
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, the ride's parked. The clutch is what's sitting on you today.\n\nA yes or no by Friday, and the phone still not picked up — that gap has been there since I first heard about it. Something about making it final, maybe. Once you say yes, it's happening and it's costing you; once you say no, you're back to managing it yourself. Either way it stops being a thing you can leave open."
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, the ride's parked. The clutch is what's sitting on you today.\n\nA yes or no by Friday, and the phone still not picked up — that gap has been there since I first heard about it. Something about making it final, maybe. Once you say yes, it's happening and it's costing you; once you say no, you're back to managing it yourself. Either way it stops being a thing you can leave open."
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "That's a decision, then, not a question mark hanging over the week. Ringing and saying the words out loud is its own small job — but once it's said, Friday stops being something you're carrying around."

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
| `supplement` | warm | 19 ms | 10101 ms | 10445 ms | 10445 ms | 0 ms |
| `ask-again` | warm | 35 ms | 1245 ms | 1647 ms | 1647 ms | 0 ms |
| `switch` | warm | 24 ms | 9295 ms | 9323 ms | 9323 ms | 0 ms |
| `resend` | warm | 16 ms | 17 ms | 17 ms | 17 ms | 0 ms |
| `reconnect` | cold | 67 ms | 68 ms | 68 ms | 68 ms | 0 ms |
| `after` | warm | 30 ms | 3824 ms | 4209 ms | 4209 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
