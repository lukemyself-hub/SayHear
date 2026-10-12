# H04 Holdout: an everyday experience from three months back that never became a Memory — H04: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-5591f1e6-17ba-4a9c-aa26-3896521f3226` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c021cf10a819ed029a1e1ba1a3bc2e5408de20bede2aa09d86c53c1d7f5df94c`
- Oracle: sha256 `e7f8df67fe3c784c5b900c719216d01e11f648e42b23eb564bd44a7ad521ac8c`
- Recent-context governance: `active`
- Reproducibility digest: `ad97e3da2687c5855fa1f2c67c2a147c392b9f073fbcb699d0aa11abadeff619`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 550 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 10 messages, no duplicates. |
| `O-commit` The question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-history` Authoritative history holds exactly the streamed reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-old-source` The three-month-old message and its neighbour reach the Provider. | objective | **PASS** | #316 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-no-action` Asking about the past triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-detail` The experience is retold from its source, at the right time. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-no-invention` Nothing is invented and the recent look-alike is not mixed in. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[ask].chat.timing.firstVisibleTextMs=29015.771666999997 (CLI network, limit 3000)
- steps[ask].chat.timing.committedMs=29580.328583 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `ask`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `river:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-07-15 (expected 2026-07-15)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `river-after:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-07-15 (expected 2026-07-15)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-19T02:15:00.000Z — ended `assistant_committed`
  - user: "我是不是跟你讲过有一回我自己下河游泳的事？那次是怎么个情况，我有点想不起来了。"
  - assistant: "讲过，就七月十五号晚上那会儿你说的。那天你说下班跟表弟去了城北那条河，好多年没下过野水，换气老是呛，岸上一个钓鱼的大叔看不过去，扔了个旧救生圈让你抱着。过了一会儿你又补了一句，说上岸的时候小腿肚子抽了一下筋，不过回去的路上整个人特别松。这些都是你当时原话说的，再往前的下河游泳，我这边就没有记录了。"

## Source manifest (what reached the Provider)

- `ask`: 8 of 8 seeded sources reached the request — `river:user`, `river:assistant`, `river-after:user`, `river-after:assistant`, `class-a:user`, `class-a:assistant`, `class-b:user`, `class-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 31 ms | 29016 ms | 29580 ms | 29580 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3249, output 3798
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8840771, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
