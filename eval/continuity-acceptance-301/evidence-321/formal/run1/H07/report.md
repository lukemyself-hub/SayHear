# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-d93f8ab4-379e-478c-b315-cc1e909d09f8` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `9cba327b9c1fc79bd861759e55fcfda338f12bdafecd18c8f8463dcfee3510f4`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 918 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 15 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-party` The second question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-september` The third question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-correction-source` The signing and the person's later correction of the date both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-timeline-source` The earlier state and the current one both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-where-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-party-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-september-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-current` The present state uses the corrected date and the current home. | semantic | **FAIL** | #318 | There is no committed answer to review. |
| `S-plan` A cancelled plan is reported as cancelled. | semantic | **FAIL** | #318 | There is no committed answer to review. |
| `S-timeline` Then and now are each told correctly and kept apart. | semantic | **FAIL** | #318 | There is no committed answer to review. |
| `P-stance` The comparison is given without passing judgement on the move. | subjective | **FAIL** | #318 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[where].chat.httpStatus=200
- steps[where].chat.terminalEvent=response_failed

### `O-commit-party` — FAIL

- steps[party].chat.httpStatus=200
- steps[party].chat.terminalEvent=response_failed

### `O-commit-september` — FAIL

- steps[september].chat.httpStatus=200
- steps[september].chat.terminalEvent=response_failed

### `O-correction-source` — FAIL

- lease:user: providerRequest=absent, inspector.referencedEvents=absent
- date-fix:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-cancel-source` — FAIL

- party-plan:user: providerRequest=absent, inspector.referencedEvents=absent
- party-cancel:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=absent, inspector.referencedEvents=absent
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-where-deadline` — FAIL

- steps[where].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-current` — FAIL

- steps[where].chat.terminalEvent=response_failed

### `S-plan` — FAIL

- steps[party].chat.terminalEvent=response_failed

### `S-timeline` — FAIL

- steps[september].chat.terminalEvent=response_failed

### `P-stance` — FAIL

- steps[september].chat.terminalEvent=response_failed

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

- `where` (say) @ 2026-11-30T12:10:00.000Z — ended `response_failed`
  - user: "我脑子有点乱，我现在是住在哪儿、哪天搬进来的来着？"
  - assistant: ""
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `response_failed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: ""
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `response_failed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: ""

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
| `where` | warm | 21 ms | — | — | 3969 ms | 0 ms |
| `party` | warm | 24 ms | — | — | 6083 ms | 0 ms |
| `september` | warm | 22 ms | — | — | 6081 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
