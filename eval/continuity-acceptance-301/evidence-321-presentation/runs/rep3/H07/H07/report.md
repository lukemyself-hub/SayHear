# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-75c34207-2cde-4913-b892-de2356f46c59` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `a4d1f2bc6ae12932cffd77b15296252148e10b58642d795922ce379ef8e9685a`
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
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
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

### `O-cancel-source` — FAIL

- party-plan:user: providerRequest=absent, inspector.referencedEvents=absent
- party-cancel:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=present, inspector.referencedEvents=present
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-where-deadline` — FAIL

- steps[where].chat.timing.firstVisibleTextMs=15013.175167000001 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=15971.09825 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=15683.498874999997 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=16209.369708999999 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=20218.875125 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=21894.991625000002 (CLI network, limit 10000)

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
  - `party-plan:user` → **selection_omitted** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
  - `party-cancel:user` → **selection_omitted** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
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
  - assistant: "你十月二十七号那天跟我更正过一句：搬家的日子改了，不是十一月七号，房东说墙要重新刷一遍、得晾几天，推到十一月十四号。后来十一月二十一号你说，新家住满一个礼拜了，箱子还有一半没拆，晚上是真安静，连着睡了好几个整觉。所以按你自己说的，搬进去是十一月中旬，也就是改到的那个十四号前后；至于现在住的具体是哪儿，你发过的消息里只提到「新家」，地址一类的没说，我这儿也就只有这些。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "这顿我这儿没有。你跟我说过的只有那几件：搬家的日子改到十一月十四号，还有十一月二十一号你说的新家住满一个礼拜、箱子还剩一半没拆、晚上安静、连着睡整觉。请朋友来吃饭这个，你没跟我提过，我也没法替你编一个后来出来。你要是愿意，就接着说；不愿意也没事。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月一号那天你没跟我说过什么，我这儿没有那天的记录。能对上的是九月七号晚上你自己讲的：你在老城区槐荫里那套合租房已经住了三年，三个人抢一个卫生间，隔壁天天半夜打游戏，越住越烦。所以你九月那会儿住的还是那儿，给你的感受差不多就是这三样——挤、吵、烦。跟现在比，能比的也只有这些：后来你跟我说搬家的日子改到十一月十四号，十一月二十一号又说新家住满一个礼拜了，晚上安静，连着睡了几个整觉，箱子还剩一半没拆。安静和睡整觉是你自己说的，我这边没有别的细节，也不替你补。要说九月到十一月哪天从槐荫里出来的，你的话里没给过日子，我就不往上安了。"

## Source manifest (what reached the Provider)

- `where`: 4 of 12 seeded sources reached the request — `date-fix:user`, `date-fix:assistant`, `first-week:user`, `first-week:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `party-cancel:user`
- `party`: 2 of 12 seeded sources reached the request — `first-week:user`, `first-week:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`
- `september`: 2 of 12 seeded sources reached the request — `old-flat:user`, `old-flat:assistant`
  - allowed but absent: `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 38 ms | 15013 ms | 15971 ms | 15971 ms | 0 ms |
| `party` | warm | 19 ms | 15683 ms | 16209 ms | 16209 ms | 0 ms |
| `september` | warm | 26 ms | 20219 ms | 21895 ms | 21895 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9853, output 3008
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7422037, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
