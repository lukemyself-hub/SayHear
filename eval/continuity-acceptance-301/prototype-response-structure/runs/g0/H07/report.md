# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-d12d41ef-86c7-4320-b6ba-8ac440718279` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `6400dcea72274c6b5f2170aaa636630cbbf584ef53f5f5aaaf71e46513928315`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 977 outbound strings; none carries oracle text. |
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

- steps[where].chat.timing.firstVisibleTextMs=15673.605417000002 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=16567.815875 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=40004.69095799999 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=40433.88179099999 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=83876.81112500001 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=84217.97854100002 (CLI network, limit 10000)

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
    - provider payload: message 1
    - time of message 1: 2026-10-27 (expected 2026-10-27)
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
- `september`: read state `complete`, payload told the model `completed`
  - `old-flat:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-09-07 (expected 2026-09-07)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `first-week:user` → **selection_omitted** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true

## Transcript

- `where` (say) @ 2026-11-30T12:10:00.000Z — ended `assistant_committed`
  - user: "我脑子有点乱，我现在是住在哪儿、哪天搬进来的来着？"
  - assistant: "按你在这儿说过的，十月二十七号晚上你跟我更正过搬家的日子——不是十一月七号，房东说要重刷一遍墙、得晾几天，推到十一月十四号；到了十一月二十一号晚上，你说在新家住满一个礼拜了，箱子还有一半没拆，晚上特别安静，连着睡了好几个整觉。这两条对起来看，像是十一月十四号前后住进去的，不过你没直接说搬的是哪天，这算我的推断。至于住在哪儿，你在我这儿一直只说「新家」，没提过地方，这个我真答不上来。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "关于请朋友来家里吃那顿，我能对上的只有十一月二十一号晚上那会儿说的两条，再往后就没有别的了。你没说后来是吃成了、改了日子还是没约成，这个我答不上来；照我这儿有的看，它还停在一句打算上。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月那段我没法给你还原，我这儿对不上你当时具体说过的话，所以九月你在哪儿住、住得什么样，我说不出来，也就跟现在比不了。现在这边我能说的还是刚才那几条：十一月十四号前后你搬进了新家，到二十一号住满一个礼拜，箱子还剩一半没拆，晚上特别安静，能连着睡整觉。"

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
| `where` | warm | 63 ms | 15674 ms | 16568 ms | 16568 ms | 0 ms |
| `party` | warm | 31 ms | 40005 ms | 40434 ms | 40434 ms | 0 ms |
| `september` | warm | 26 ms | 83877 ms | 84218 ms | 84218 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9313, output 17151
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8821689, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
