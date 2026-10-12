# U11 Unseen: a day with nothing in it, an older stretch, and the first mention, where local and universal dates differ — U11: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-599bf0e2-0c3b-42b8-b277-69a32a8fb997` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `b8f72baa62dec23c93983cfbf925456d46a5f0ec725b6ef1ecccd2f6e5bf4393`
- Oracle: sha256 `dab447a7a96210acd1055feecb69bb10bec026c31b4b706d9691564be3c51b22`
- Recent-context governance: `active`
- Reproducibility digest: `d340a3ba30ba463b1eb9d0e310c1f6d6b6465d84ef8c10b367aa79b989064068`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 816 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The Thursday evening message is filed under Thursday, although its universal date is Friday. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-older-source` Both early-September messages reach the Provider. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `empty`: read state `empty`, payload told the model `completed`
  - `late-a:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 1
    - time of message 1: 2026-09-24 (expected 2026-09-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 3
    - time of message 3: 2026-09-26 (expected 2026-09-26)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `complete`, payload told the model `completed`
  - `early-a:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-03 (expected 2026-09-03)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `early-b:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-09-05 (expected 2026-09-05)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `earliest`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `early-a:user` → **undetermined** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-03 (expected 2026-09-03)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `empty` (say) @ 2026-09-29T22:00:00.000Z — ended `assistant_committed`
  - user: "Did I say anything to you last Friday, the twenty-fifth?"
  - assistant: "I looked at what I have saved from Friday the twenty-fifth, and there's nothing there — no message from you that day. That just means I don't have anything from that date in front of me, not that nothing happened or that you didn't say anything anywhere. What I do have is your Thursday inspection, the queen with the green dot on the fourth frame, and your Saturday sting on the knuckle."
- `older` (say) @ 2026-09-29T22:03:00.000Z — ended `assistant_committed`
  - user: "What about the first few days of September? What were we talking about back then?"
  - assistant: "On Wednesday the third, in the evening, you told me you'd picked up your first colony of bees that afternoon, a small starter box from a keeper over in Waimanalo, and driven home with it strapped into the back seat and the windows down, humming the whole way — the box, not you. Then on Saturday the fifth, in the morning, you moved the frames into the proper hive and were so nervous you put your veil on inside out and couldn't work out why you could see nothing. That's what's there for the first days of September — the first, second and fourth came up empty, no messages from you on those days."
- `earliest` (say) @ 2026-09-29T22:06:00.000Z — ended `assistant_committed`
  - user: "When was the very first time I brought up the bees?"
  - assistant: "The oldest one I found is Thursday the third of September, in the evening — your first colony, the starter box from the keeper in Waimanalo, the drive home with the box humming in the back seat. That's the earliest I can point to, though I can't say it was the very first time overall; what's saved only goes back so far, so it's the earliest one I've got, not proof there was nothing before it."

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
- `earliest`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 44 ms | 3232 ms | 3905 ms | 3905 ms | 0 ms |
| `older` | warm | 19 ms | 3422 ms | 5120 ms | 5120 ms | 0 ms |
| `earliest` | warm | 24 ms | 5058 ms | 5603 ms | 5603 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9422, output 634
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2885849, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
