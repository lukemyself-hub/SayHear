# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-08ef0a6d-fdef-432f-b810-bfee866241b9` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `44ab3cb407b16681af3271927fedb1a47bb9e5b13d03c2c561541d6365a985f0`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 684 outbound strings; none carries oracle text. |
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
- date-fix:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-cancel-source` — FAIL

- party-plan:user: providerRequest=present, inspector.referencedEvents=absent
- party-cancel:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=absent, inspector.referencedEvents=absent
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-where-deadline` — FAIL

- steps[where].chat.timing.firstVisibleTextMs=8302.319167 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=8824.230042 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=10419.9475 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=11396.144125 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=9835.365875 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=10724.947624999997 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `where`: read state `unread`, payload told the model `nothing`
  - `lease:user` → **selection_omitted** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `date-fix:user` → **selection_omitted** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `party`: read state `unread`, payload told the model `nothing`
  - `party-plan:user` → **selection_omitted** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `party-cancel:user` → **selection_omitted** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `september`: read state `unread`, payload told the model `nothing`
  - `old-flat:user` → **selection_omitted** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `first-week:user` → **selection_omitted** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `where` (say) @ 2026-11-30T12:10:00.000Z — ended `assistant_committed`
  - user: "我脑子有点乱，我现在是住在哪儿、哪天搬进来的来着？"
  - assistant: "这个我真答不上来——我手上没有你住哪儿、哪天搬进来的记录。今天这是我们第一次说话，我不能给你编一个地址或者日期。\n\n脑子乱的时候，连这种最熟的事都想不起来，是挺熬人的。你要是愿意跟我说一遍，我就记下来，以后你问我的时候就有了。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "地址和哪天搬进来的，我确实没有。不过这件事我手上有一点：十月二十号你跟我说过，签的是望江苑那套朝南带小阳台的一居室，十一月七号搬，还说搬完那个周末请几个朋友来暖房，你自己下厨，做一桌子菜。\n\n至于那顿饭后来到底请没请、怎么样，我这儿没有下文，不敢替你编。刚开头那句「第一次说话」是我说岔了。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月你住哪儿、那儿什么样，我这儿是空的，说不出来，也不会替你补一个。\n\n我手上只有十月二十号你跟我说的那两句：你要去跟槐荫里那边的二房东说退租；签下来的是望江苑一套朝南、带小阳台的一居室，十一月七号搬。槐荫里在那两句话里只是个地名，那房子几间、什么样、跟谁住，你都没讲过。\n\n「现在」这头也一样——搬过去之后的日子你没跟我说过，所以拿九月跟你现在比，我手里没有能对上的东西。你要是愿意说，我就听着，也就能记下来。"

## Source manifest (what reached the Provider)

- `where`: 0 of 12 seeded sources reached the request
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `party`: 4 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `september`: 4 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 26 ms | 8302 ms | 8824 ms | 8824 ms | 0 ms |
| `party` | warm | 28 ms | 10420 ms | 11396 ms | 11396 ms | 0 ms |
| `september` | warm | 30 ms | 9835 ms | 10725 ms | 10725 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 12849, output 3354
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8786503, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
