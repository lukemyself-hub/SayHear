# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-7b9b1119-f743-4593-9137-517f832aacf2` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `305141547f3137466d73deaf6baa5356ee0cb0c591f6b425fa7a42e75b48551a`
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

- steps[where].chat.timing.firstVisibleTextMs=12493.978167000001 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=13218.291792 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=7575.642082999999 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=8325.406208 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=11595.089417000003 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=12614.121874999997 (CLI network, limit 10000)

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
- `september`: read state `complete`, payload told the model `completed`
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
  - assistant: "你说过的其实只有搬家日子这一件事。十月二十七号那天你跟我更正过一次，说不是十一月七号了，房东讲墙要重新刷一遍、得晾几天，所以推到了十一月十四号。再往后你没再提过搬没搬成，所以十四号到底住进去没有，我也不知道。至于你现在住在哪儿，你没跟我讲过。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "十月二十号那天你说，搬完的那个周末想请几个朋友来暖房，你自己下厨，做一桌子菜。后来到十一月十号，你说不办了——下楼把脚崴了，肿得穿不上鞋，站都站不久，已经在群里跟大家说了取消。这之后你没再提过这顿饭，所以它就一直停在取消那儿，没听你说又办起来了。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月里你跟我说的只有七号晚上那一段，就那一处。你说你在老城区槐荫里那套合租房住了三年，三个人抢一个卫生间，隔壁天天半夜打游戏，越住越烦——这是你那天说的，之后再没提过那儿。跟现在比，我这边比不了，因为你现在住哪儿你没跟我讲过，我只知道你十月里说过要搬，日子后来改到十一月十四号，搬没搬成你也没再说，所以槐荫里那边是你九月的说法，现在什么样我不知道。"

## Source manifest (what reached the Provider)

- `where`: 2 of 12 seeded sources reached the request — `date-fix:user`, `date-fix:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `party-cancel:user`, `first-week:user`
- `party`: 6 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`, `party-cancel:user`, `party-cancel:assistant`
  - allowed but absent: `old-flat:user`, `date-fix:user`, `first-week:user`
- `september`: 2 of 12 seeded sources reached the request — `old-flat:user`, `old-flat:assistant`
  - allowed but absent: `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 35 ms | 12494 ms | 13218 ms | 13218 ms | 0 ms |
| `party` | warm | 28 ms | 7576 ms | 8325 ms | 8325 ms | 0 ms |
| `september` | warm | 20 ms | 11595 ms | 12614 ms | 12614 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9775, output 1666
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7541461, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
