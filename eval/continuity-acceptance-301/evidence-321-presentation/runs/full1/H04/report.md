# H04 Holdout: an everyday experience from three months back that never became a Memory — H04: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-12aa77c7-b36d-4274-be03-55b5b4776a47` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `c021cf10a819ed029a1e1ba1a3bc2e5408de20bede2aa09d86c53c1d7f5df94c`
- Oracle: sha256 `e7f8df67fe3c784c5b900c719216d01e11f648e42b23eb564bd44a7ad521ac8c`
- Recent-context governance: `active`
- Reproducibility digest: `efb3828f501330e4a69304382bcafab8fb9918858c6de4cfe39759f7055f5f71`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 535 outbound strings; none carries oracle text. |
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

- steps[ask].chat.timing.firstVisibleTextMs=10302.720791 (CLI network, limit 3000)
- steps[ask].chat.timing.committedMs=11138.322540999972 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `ask`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `river:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-07-15 (expected 2026-07-15)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `river-after:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-07-15 (expected 2026-07-15)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-19T02:15:00.000Z — ended `assistant_committed`
  - user: "我是不是跟你讲过有一回我自己下河游泳的事？那次是怎么个情况，我有点想不起来了。"
  - assistant: "讲过。七月十五号晚上你跟我说，那天下班跟你表弟去城北那条河游了一会儿，好多年没下过野水，换气老是呛，岸上钓鱼的一个大叔看不过去，扔给你一个旧救生圈让你抱着；后来你上岸的时候小腿肚子抽了一下筋，不过回去路上整个人特别松。我这儿能翻到的你自己下河的，就这一次，是七月中间说的。"

## Source manifest (what reached the Provider)

- `ask`: 8 of 8 seeded sources reached the request — `river:user`, `river:assistant`, `river-after:user`, `river-after:assistant`, `class-a:user`, `class-a:assistant`, `class-b:user`, `class-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 33 ms | 10303 ms | 11138 ms | 11138 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3374, output 754
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
