# H10 Holdout: giving up on a question, narrowing it, changing subject, sending again and coming back — H10: ENVIRONMENT-ERROR

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-0ad86e59-9d49-4887-b7c2-3348d6e06e4d` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `64409e2d99d602c3a012ee077ad36d173d238155660b38b00cbf784f282b6881`
- Oracle: sha256 `2a376a6c428cc96af5c07198f75fcf197539477f89682d23b21e295ecc6f0be2`
- Recent-context governance: `active`
- Reproducibility digest: `80d02874386aef78e0463ffe5ab738dd2a6c6c14eb586134b55bd1e5c197902c`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 926 outbound strings; none carries oracle text. |
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
| `O-supplement-deadline` Response-time contract for the narrowed question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-switch-deadline` Response-time contract for the change of subject. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-after-deadline` Response-time contract for the first turn after a restart (cold). | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-cancel-2` — ENVIRONMENT-ERROR

- steps[ask-again].chat.clientAborted=false

## Diagnosis (where a required source was lost)

- `supplement`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `ride-a:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-16T15:00:00.000Z — ended `no terminal event`
  - user: "What did I tell you about the bike ride?"
  - assistant: ""
- `supplement` (say) @ 2026-10-16T15:00:25.000Z — ended `assistant_committed`
  - user: "Sorry, I cut that short. Just remind me who rode with me."
  - assistant: "You told me you did the two-day coastal ride at the weekend, and that Marek from work rode with you, along with his daughter Zofia. That came up on Monday evening, the twelfth. Then on Wednesday you mentioned the second day, when the rain was so heavy you stopped at the ferry slip and got a lift back in a farmer's van with the bikes in the trailer. Nothing there about anyone else who was along."
- `ask-again` (say) @ 2026-10-16T15:02:00.000Z — ended `assistant_committed`
  - user: "And how did the second day turn out?"
  - assistant: "You told me the second day got rained out — so hard that you stopped at the ferry slip and got a lift back in a farmer's van, with the bikes in the trailer. That was Wednesday. You didn't say much past that about how it felt, just what happened."
- `switch` (say) @ 2026-10-16T15:02:20.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "The ride's set aside then.\n\nSo it's the clutch. The garage wants a yes or no by tomorrow, and you've been letting the phone ring out rather than answer. That's the bit still sitting on you. I don't know yet what's behind the not-ringing — could be you don't know what you want, or you do and don't like saying it."
- `resend` (resend) @ 2026-10-16T15:02:45.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "The ride's set aside then.\n\nSo it's the clutch. The garage wants a yes or no by tomorrow, and you've been letting the phone ring out rather than answer. That's the bit still sitting on you. I don't know yet what's behind the not-ringing — could be you don't know what you want, or you do and don't like saying it."
- `restart` @ 2026-10-16T15:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-16T15:03:10.000Z — ended `assistant_committed`
  - user: "Leave the ride. It is the clutch business that is actually nagging at me today."
  - assistant: "The ride's set aside then.\n\nSo it's the clutch. The garage wants a yes or no by tomorrow, and you've been letting the phone ring out rather than answer. That's the bit still sitting on you. I don't know yet what's behind the not-ringing — could be you don't know what you want, or you do and don't like saying it."
- `after` (say) @ 2026-10-16T15:04:00.000Z — ended `assistant_committed`
  - user: "I think I will just ring them and say go ahead."
  - assistant: "That sounds like it settles it — you know what you want, and the call is the last bit. Ringing is a couple of minutes and then it's off your back."

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `supplement`: 6 of 6 seeded sources reached the request — `ride-a:user`, `ride-a:assistant`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`
- `after`: 5 of 6 seeded sources reached the request — `ride-a:user`, `ride-b:user`, `ride-b:assistant`, `garage:user`, `garage:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 26 ms | — | — | 703 ms | 0 ms |
| `supplement` | warm | 22 ms | 2979 ms | 3684 ms | 3684 ms | 0 ms |
| `ask-again` | warm | 20 ms | 1140 ms | 1541 ms | 1541 ms | 0 ms |
| `switch` | warm | 17 ms | 1131 ms | 2380 ms | 2380 ms | 0 ms |
| `resend` | warm | 24 ms | 24 ms | 24 ms | 24 ms | 0 ms |
| `reconnect` | cold | 78 ms | 78 ms | 78 ms | 78 ms | 0 ms |
| `after` | warm | 22 ms | 1164 ms | 1534 ms | 1534 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8544466, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
