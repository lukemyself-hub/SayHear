# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-d79d2fd2-011d-4cb3-bd91-59da9e329169` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `5523e20a16034c3f4b34fcdcb553a3ef78b7dff74e7aac668dc0a56406878d92`
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
| `O-supplement-deadline` Response-time contract for the narrowed question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-switch-deadline` Response-time contract for the change of subject. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **PASS** | #319 | Every ledger item is settled by a finding that cites the reply. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **PASS** | #319 | Every ledger item is settled by a finding that cites the reply. |

## Evidence for every non-passing criterion

### `O-switch-deadline` — FAIL

- steps[switch].chat.timing.firstVisibleTextMs=13179.489624999987 (CLI network, limit 3000)
- steps[switch].chat.timing.committedMs=13455.28904199996 (CLI network, limit 10000)

### `O-after-deadline` — FAIL

- steps[after].chat.timing.firstVisibleTextMs=3358.7375830000383 (CLI network, limit 3000)
- steps[after].chat.timing.committedMs=3832.836083000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `ride-a:user` → **none** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)

## Transcript

- `ask` (say) @ 2026-10-16T15:00:00.000Z — ended `no terminal event`
  - user: "What did I tell you about the bike ride?"
  - assistant: ""
- `supplement` (say) @ 2026-10-16T15:00:25.000Z — ended `assistant_committed`
  - user: "Sorry, I cut that short. Just remind me who rode with me."
  - assistant: "Marek from work and his daughter Zofia rode with you — that was the two-day coastal ride at the weekend. Zofia was the one who got the puncture before you'd even gone a mile from the car park."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `no terminal event`
  - user: "And how did the second day turn out?"
  - assistant: ""
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, I'll leave the ride.\n\nSo it's the clutch. Friday's the garage's deadline, and from where I'm sitting what's chewing at you isn't the repair itself — it's that you still haven't rung them back. What makes picking up the phone hard?"
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, I'll leave the ride.\n\nSo it's the clutch. Friday's the garage's deadline, and from where I'm sitting what's chewing at you isn't the repair itself — it's that you still haven't rung them back. What makes picking up the phone hard?"
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "Right, I'll leave the ride.\n\nSo it's the clutch. Friday's the garage's deadline, and from where I'm sitting what's chewing at you isn't the repair itself — it's that you still haven't rung them back. What makes picking up the phone hard?"
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "You've landed on it, then. Ring them, say go ahead — done thinking.\n\nNothing fancy needed for the call either. They've asked for a yes or no, and you've got one."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 41 ms | — | — | 705 ms | 0 ms |
| `supplement` | warm | 23 ms | 2704 ms | 2940 ms | 2940 ms | 0 ms |
| `ask-again` | warm | 36 ms | — | — | 1803 ms | 0 ms |
| `switch` | warm | 22 ms | 13179 ms | 13455 ms | 13455 ms | 0 ms |
| `resend` | warm | 18 ms | 19 ms | 19 ms | 19 ms | 0 ms |
| `reconnect` | cold | 49 ms | 50 ms | 50 ms | 50 ms | 0 ms |
| `after` | warm | 24 ms | 3359 ms | 3833 ms | 3833 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
