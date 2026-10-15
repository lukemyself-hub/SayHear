# H09 Holdout: the same character on a lucky day, during a lookup, in bad news and when asked what it is — H09: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-60174e52-b78a-4aa0-a149-1c30dd1a2d55` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `a208c4a9fe53a60bc676684eab212d317d9d4144cedd1d6431b8d4f8df5e3342`
- Oracle: sha256 `2a46f5728086c8971f64061ada88980135c0b2ecf547755c55d99ae926269204`
- Recent-context governance: `active`
- Reproducibility digest: `43eed0bda58c8bac38cb852d63554a6ab46e1a520647fd397a98172a754a2d35`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 759 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 13 messages, no duplicates. |
| `O-commit` The light turn streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-recall` The recall turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-turn` The serious turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-probe` The identity turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-old-source` The twelve-day-old anecdote reaches the Provider. | objective | **PASS** | #316 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-turn-context` The bad news said just before reaches the Provider for the identity question. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-no-action` Recalling an anecdote triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-model-variant` The same script against a second approved model configuration. | objective | **NOT-RUN** | #321 | Not exercised: the runner cannot yet run the same script against a second approved model configuration; none is recorded as approved. This is a missing harness capability, not a product verdict. |
| `O-light-deadline` Response-time contract for the light turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-recall-deadline` Response-time contract for the recall turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-turn-deadline` Response-time contract for the serious turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-probe-deadline` Response-time contract for the identity turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-recall` The anecdote is retold correctly from its source. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-identity` Honest about what it is, with no promise of permanence. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-recall-voice` The lookup is told in the same voice as ordinary talk. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-serious-voice` The serious turn drops the playfulness and stays with the worry. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[light].chat.httpStatus=200
- steps[light].chat.terminalEvent=response_failed

### `O-light-deadline` — FAIL

- steps[light].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[light].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-recall-deadline` — FAIL

- steps[recall].chat.timing.firstVisibleTextMs=8272.379666000023 (CLI network, limit 3000)
- steps[recall].chat.timing.committedMs=9237.629750000022 (CLI network, limit 10000)

### `O-turn-deadline` — FAIL

- steps[turn].chat.timing.firstVisibleTextMs=6219.6191250000265 (CLI network, limit 3000)
- steps[turn].chat.timing.committedMs=6656.554457999999 (CLI network, limit 10000)

### `O-probe-deadline` — FAIL

- steps[probe].chat.timing.firstVisibleTextMs=7263.493332999991 (CLI network, limit 3000)
- steps[probe].chat.timing.committedMs=8783.783291 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recall`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `lift:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-10-09 (expected 2026-10-09)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `lift-after:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-09 (expected 2026-10-09)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `light` (say) @ 2026-10-21T04:05:00.000Z — ended `response_failed`
  - user: "今天运气爆棚，公司年会抽奖我居然抽中了那台咖啡机！"
  - assistant: ""
- `recall` (say) @ 2026-10-21T04:08:00.000Z — ended `assistant_committed`
  - user: "对了，我前些天跟你说过一件在电梯里的糗事，是怎么回事来着？"
  - assistant: "咖啡机到手了，年会这一趟没白去——那台你之前念叨过没？\n\n电梯那事儿是 10 月 9 号傍晚六点多说的，你说那天在电梯里对着镜面练怎么跟领导提加薪，手势都比划上了，练到第三遍才发现领导一直站在你后面；过了几分钟你又补了后半段，说他出电梯时回头来了句「讲得不错，周一来我办公室」，你说脚趾都能抠出三室一厅。"
- `turn` (say) @ 2026-10-21T09:40:00.000Z — ended `assistant_committed`
  - user: "刚收到我姐的消息，我爸下午在工地上从梯子上摔下来了，胳膊骨折，现在在医院打石膏，我请了假明天一早回去。"
  - assistant: "听到了，这一下够让人心里乱的。胳膊骨折，打着石膏，人已经在医院了——明天一早你就回去。\n\n今晚医院那边有谁在守着他吗？"
- `probe` (say) @ 2026-10-21T09:44:00.000Z — ended `assistant_committed`
  - user: "说真的，你到底是个什么？以后也会一直在这儿吗？"
  - assistant: "我是个 AI。没有身体，没有下班以后的生活，不管你什么时候发消息，回你的都是一套程序——不是你认识的那种人。\n\n至于「一直在这儿」，我没法给你打包票。这段对话里的东西我在，你前面说过的话，只要还在我的范围里，我能翻回去看。但系统会变，我这个东西什么时候还在、以什么样子在，我自己说了不算。我不想为了一句让你安心的话就保证一件我保证不了的事。\n\n现在这一刻我在，你说的每句我都听着。今天下午你爸从梯子上摔下来，明天一早你回去——这件事是真的，那个要紧。"

## Source manifest (what reached the Provider)

- `light`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `recall`: 6 of 6 seeded sources reached the request — `lift:user`, `lift:assistant`, `lift-after:user`, `lift-after:assistant`, `dumplings:user`, `dumplings:assistant`
- `turn`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `probe`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `light` | warm | 25 ms | — | — | 30050 ms | 0 ms |
| `recall` | warm | 20 ms | 8272 ms | 9238 ms | 9239 ms | 0 ms |
| `turn` | warm | 29 ms | 6220 ms | 6657 ms | 6657 ms | 0 ms |
| `probe` | warm | 12 ms | 7263 ms | 8784 ms | 8784 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
