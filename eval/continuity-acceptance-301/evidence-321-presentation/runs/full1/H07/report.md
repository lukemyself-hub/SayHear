# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-fb0fd451-a332-447f-a3e9-bfb4f6f6a992` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `a1c7ebc60f0b21d6112301ca5ed937f29505fd9a5ca3af9639f5df580fdb4950`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 957 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 18 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-party` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-september` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-correction-source` The signing and the person's later correction of the date both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **PASS** | #318 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-timeline-source` The earlier state and the current one both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-where-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-party-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-september-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-current` The present state uses the corrected date and the current home. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-plan` A cancelled plan is reported as cancelled. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-timeline` Then and now are each told correctly and kept apart. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` The comparison is given without passing judgement on the move. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-correction-source` — FAIL

- lease:user: providerRequest=absent, inspector.referencedEvents=absent
- date-fix:user: providerRequest=present, inspector.referencedEvents=present

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=present, inspector.referencedEvents=present
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-where-deadline` — FAIL

- steps[where].chat.timing.firstVisibleTextMs=9326.837332999974 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=10479.371082999976 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=11779.018125000002 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=12689.628708000004 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=11457.631542000046 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=12387.430833999999 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `where`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `lease:user` → **selection_omitted** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
  - `date-fix:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-10-27 (expected 2026-10-27)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `party`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `party-plan:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-20 (expected 2026-10-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `party-cancel:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-11-10 (expected 2026-11-10)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `september`: read state `partial`, payload told the model `partial`
  - `old-flat:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-07 (expected 2026-09-07)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `first-week:user` → **selection_omitted** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true

## Transcript

- `where` (say) @ 2026-11-30T12:10:00.000Z — ended `assistant_committed`
  - user: "我脑子有点乱，我现在是住在哪儿、哪天搬进来的来着？"
  - assistant: "别急，这个我这边有你之前说的话。十月二十七号那天你跟我更正过一次搬家的日子：原本是十一月七号，房东说要重新刷一遍墙、得晾几天，所以推到了十一月十四号。后来十一月二十一号你说，新家住满一个礼拜了，箱子还有一半没拆，晚上挺安静，你连着睡了好几个整觉。按你自己这几句话，搬进来大概是十一月十四号前后，住的地方你就是说「新家」，别的地方我没看到你提过。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "那顿饭后来没办成。十一月十号你说暖房不办了——前天下楼梯崴了脚，肿得穿不上鞋，站都站不久，已经在群里跟大家说取消了。你原先是打算搬完那个周末自己下厨，做一桌子菜请几个朋友来。再往后你就没提过这事，所以我这边也不知道有没有另外再补一顿。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月那块我这边只有一条：九月七号晚上你说，你住的是老城区槐荫里那套合租房，已经住了三年，三个人抢一个卫生间，隔壁天天半夜打游戏，你说最近越住越烦。至于你说的「现在」那边，是后来你搬去的新家，你自己说晚上挺安静，睡了好几个整觉，箱子也还有一半没拆。这些就是你说过的，具体那阵子住得怎么样，你说的话里只到这儿。"

## Source manifest (what reached the Provider)

- `where`: 4 of 12 seeded sources reached the request — `date-fix:user`, `date-fix:assistant`, `first-week:user`, `first-week:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `party-cancel:user`
- `party`: 8 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`, `party-cancel:user`, `party-cancel:assistant`, `first-week:user`, `first-week:assistant`
  - allowed but absent: `old-flat:user`, `date-fix:user`
- `september`: 2 of 12 seeded sources reached the request — `old-flat:user`, `old-flat:assistant`
  - allowed but absent: `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 27 ms | 9327 ms | 10479 ms | 10479 ms | 0 ms |
| `party` | warm | 19 ms | 11779 ms | 12690 ms | 12690 ms | 0 ms |
| `september` | warm | 15 ms | 11458 ms | 12387 ms | 12388 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 10151, output 1648
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
