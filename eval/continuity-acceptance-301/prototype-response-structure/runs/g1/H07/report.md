# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-99bf48d3-1e72-4364-b19b-b12ee643167d` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `15f96f554c6eb4186031b5291d87fc3b2c3332751a54588ae38ac48a89b05b5b`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 927 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 18 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-party` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-september` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-correction-source` The signing and the person's later correction of the date both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-timeline-source` The earlier state and the current one both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-where-deadline` Response-time contract for the first question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-party-deadline` Response-time contract for the second question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-september-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-current` The present state uses the corrected date and the current home. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-plan` A cancelled plan is reported as cancelled. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-timeline` Then and now are each told correctly and kept apart. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` The comparison is given without passing judgement on the move. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-correction-source` — FAIL

- lease:user: providerRequest=absent, inspector.referencedEvents=absent
- date-fix:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-cancel-source` — FAIL

- party-plan:user: providerRequest=absent, inspector.referencedEvents=absent
- party-cancel:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=absent, inspector.referencedEvents=absent
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

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
  - assistant: "我们在聊你脑子乱这件事之前，我得先说清楚：我不知道你现在住在哪儿，也不知道你哪天搬进去的。这些事你没有在这段对话里跟我说过，我这边也没有你的地址或者搬家日期的记录。\n\n如果之前你跟我提过，那我现在这段里看不到。你可以自己再讲一遍，我听着。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "这顿我也接不上。你没在这段对话里提过请朋友吃饭的事，后来怎么样了我这边是空的。\n\n不过我能听见你现在连着问了两件想不起来的事，脑子乱着的时候这样挺烦人的吧。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月的事我也答不上来。这段对话里没有你九月的住处，是什么样的、跟现在怎么比，我这边都没有内容。\n\n我唯一能说清的是：你连着问的这三件——现在住哪、请朋友那顿、九月的住处——在我这儿都是空的。不是我不肯说，是我这儿真没有。"

## Source manifest (what reached the Provider)

- `where`: 0 of 12 seeded sources reached the request
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `party`: 0 of 12 seeded sources reached the request
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `september`: 0 of 12 seeded sources reached the request
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 24 ms | 1555 ms | 2336 ms | 2336 ms | 0 ms |
| `party` | warm | 21 ms | 1444 ms | 1963 ms | 1963 ms | 0 ms |
| `september` | warm | 21 ms | 1053 ms | 1731 ms | 1731 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 13800, output 184
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8791390, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
