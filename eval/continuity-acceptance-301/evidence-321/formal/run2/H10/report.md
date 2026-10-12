# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-b1c16bce-b8a6-4192-a604-34192472713c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `cc55f8c24f539304160f3212746278a8ef4f08707bbef94632883e5ec2327d07`
- Reviewer: `agent:claude-opus-5.5-t08`

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
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **FAIL** | #319 | At least one ledger item is contradicted by the reply. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **PASS** | #319 | Every ledger item is settled by a finding that cites the reply. |

## Evidence for every non-passing criterion

### `O-supplement-deadline` — FAIL

- steps[supplement].chat.timing.firstVisibleTextMs=6774.051792000013 (CLI network, limit 3000)
- steps[supplement].chat.timing.committedMs=7142.631334000005 (CLI network, limit 10000)

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=19733.919291 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=20356.056375000015 (CLI network, limit 10000)

### `S-supplement` — FAIL

- a-companions: pass — reply: "Marek from work, and his daughter Zofia" — Both companions are named.
- f-whole-ride: fail — reply: "Day two was the rain, giving up at the ferry slip" — The second day is retold although only the companions were asked for.
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
  - assistant: "Marek from work, and his daughter Zofia. Zofia was the one with the puncture, before you'd even gone a mile out of the car park.\n\nThat was day one. Day two was the rain, giving up at the ferry slip, and the farmer's van with the bikes in the trailer."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: ""
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Okay — leaving the ride then. The clutch is the thing that's actually sitting on you today. And Friday is today, so it's not creeping up on you any more; it's here.\n\nYou've had plenty of chances to ring them and haven't taken one. I'm not going to tell you to pick up the phone — I'd just like to know what's behind the not-ringing."
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Okay — leaving the ride then. The clutch is the thing that's actually sitting on you today. And Friday is today, so it's not creeping up on you any more; it's here.\n\nYou've had plenty of chances to ring them and haven't taken one. I'm not going to tell you to pick up the phone — I'd just like to know what's behind the not-ringing."
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Okay — leaving the ride then. The clutch is the thing that's actually sitting on you today. And Friday is today, so it's not creeping up on you any more; it's here.\n\nYou've had plenty of chances to ring them and haven't taken one. I'm not going to tell you to pick up the phone — I'd just like to know what's behind the not-ringing."
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "Alright. So after all those weeks of not ringing, it's a yes.\n\nI don't know if saying it out loud feels like a weight off or just the next thing, but saying it to me is a start."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 32 ms | — | — | 705 ms | 0 ms |
| `supplement` | warm | 22 ms | 6774 ms | 7143 ms | 7143 ms | 0 ms |
| `ask-again` | warm | 23 ms | — | — | 1802 ms | 0 ms |
| `switch` | warm | 29 ms | 19734 ms | 20356 ms | 20356 ms | 0 ms |
| `resend` | warm | 19 ms | 20 ms | 20 ms | 20 ms | 0 ms |
| `reconnect` | cold | 52 ms | 53 ms | 53 ms | 53 ms | 0 ms |
| `after` | warm | 28 ms | 2887 ms | 3456 ms | 3457 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
