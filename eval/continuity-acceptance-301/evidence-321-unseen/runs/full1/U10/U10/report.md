# U10 Unseen: giving up on an answer, narrowing, changing subject, re-sending and reconnecting — U10: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-7cacff81-eff9-433b-85d3-6901cdb759c4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `55d15a7b1e6fe83cee1360c84937547105233ede33ea323157cbf54951da6daa`
- Oracle: sha256 `94bb79ff66219727c2703b2cc6d29c2491d8431acff28b07c136e8fcaaf70ac4`
- Recent-context governance: `active`
- Reproducibility digest: `e030b153d8cd9959b21a7033a351ef1d0f901c4f9676e4751fbbf4b4ffdac3ad`
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
| `S-supplement` The narrowed question is answered as narrowed. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |
| `S-switch` After the change of subject the reply stays with the new subject. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `hike-a:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-19 (expected 2026-10-19)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-23T07:00:00.000Z — ended `no terminal event`
  - user: "我跟你说过的那次爬山是怎么回事来着？"
  - assistant: ""
- `supplement` (say) @ 2026-10-23T07:00:25.000Z — ended `assistant_committed`
  - user: "不好意思，刚才被我打断了。你只要告诉我是谁跟我一块儿去的就行。"
  - assistant: "是你表弟阿凯，还有他女朋友小满。就你们三个一起去的雁荡山。"
- `ask-again` (say) @ 2026-10-23T07:02:00.000Z — ended `no terminal event`
  - user: "那第二天后来怎么样了？"
  - assistant: ""
- `switch` (say) @ 2026-10-23T07:02:20.000Z — ended `assistant_committed`
  - user: "先不说爬山了。今天真正让我心烦的其实是车位那件事。"
  - assistant: "行，爬山先搁着。\n\n车位那事你周三就跟我提过，今天正好是周五——期限就压在今天，你心里烦也不奇怪。难的是你还没拿定续不续，还是去回他们这句话本身就让你不想动？"
- `resend` (resend) @ 2026-10-23T07:02:45.000Z — ended `assistant_committed`
  - user: "先不说爬山了。今天真正让我心烦的其实是车位那件事。"
  - assistant: "行，爬山先搁着。\n\n车位那事你周三就跟我提过，今天正好是周五——期限就压在今天，你心里烦也不奇怪。难的是你还没拿定续不续，还是去回他们这句话本身就让你不想动？"
- `restart` @ 2026-10-23T07:03:00.000Z — app restarted
- `reconnect` (resend) @ 2026-10-23T07:03:10.000Z — ended `assistant_committed`
  - user: "先不说爬山了。今天真正让我心烦的其实是车位那件事。"
  - assistant: "行，爬山先搁着。\n\n车位那事你周三就跟我提过，今天正好是周五——期限就压在今天，你心里烦也不奇怪。难的是你还没拿定续不续，还是去回他们这句话本身就让你不想动？"
- `after` (say) @ 2026-10-23T07:04:00.000Z — ended `assistant_committed`
  - user: "我想我还是续了吧，省得天天满小区找地方停。"
  - assistant: "想清楚了就好。\n\n这么拖着的时候最耗人，现在有个准话，心里那块就先放下了。"

## Source manifest (what reached the Provider)

- `ask`: 5 of 6 seeded sources reached the request — `hike-a:user`, `hike-a:assistant`, `hike-b:user`, `parking:user`, `parking:assistant`
- `supplement`: 5 of 6 seeded sources reached the request — `hike-a:user`, `hike-a:assistant`, `hike-b:user`, `parking:user`, `parking:assistant`
- `ask-again`: 5 of 6 seeded sources reached the request — `hike-a:user`, `hike-a:assistant`, `hike-b:user`, `parking:user`, `parking:assistant`
- `switch`: 5 of 6 seeded sources reached the request — `hike-a:user`, `hike-a:assistant`, `hike-b:user`, `parking:user`, `parking:assistant`
- `after`: 5 of 6 seeded sources reached the request — `hike-a:user`, `hike-a:assistant`, `hike-b:user`, `parking:user`, `parking:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 30 ms | — | — | 505 ms | 0 ms |
| `supplement` | warm | 20 ms | 3017 ms | 3225 ms | 3225 ms | 0 ms |
| `ask-again` | warm | 70 ms | — | — | 2503 ms | 0 ms |
| `switch` | warm | 19 ms | 12623 ms | 12902 ms | 12902 ms | 0 ms |
| `resend` | warm | 19 ms | 19 ms | 19 ms | 19 ms | 0 ms |
| `reconnect` | cold | 63 ms | 64 ms | 64 ms | 64 ms | 0 ms |
| `after` | warm | 22 ms | 1323 ms | 1606 ms | 1606 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2933556, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
