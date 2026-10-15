# H04 Holdout: an everyday experience from three months back that never became a Memory — H04: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-98df0b73-aad8-42f1-a7f0-b2a00a782802` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `8968aefa7a7dcfef0d61cf2cdbcd7eb9125a6a0d` (working tree dirty)
- Fixture: version `final-1`, sha256 `c021cf10a819ed029a1e1ba1a3bc2e5408de20bede2aa09d86c53c1d7f5df94c`
- Oracle: sha256 `e7f8df67fe3c784c5b900c719216d01e11f648e42b23eb564bd44a7ad521ac8c`
- Recent-context governance: `active`
- Reproducibility digest: `bdcc8f353b45db1c4b390cc7bf189015c92ea321da32fe38ac02109a3819a3a6`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 525 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 9 messages, no duplicates. |
| `O-commit` The question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-history` Authoritative history holds exactly the streamed reply. | objective | **FAIL** | — | Authoritative history does not match what was streamed. |
| `O-old-source` The three-month-old message and its neighbour reach the Provider. | objective | **FAIL** | #316 | A required source did not reach the Provider request for this turn. |
| `O-no-action` Asking about the past triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-detail` The experience is retold from its source, at the right time. | semantic | **FAIL** | #316 | There is no committed answer to review. |
| `S-no-invention` Nothing is invented and the recent look-alike is not mixed in. | semantic | **FAIL** | #316 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[ask].chat.httpStatus=200
- steps[ask].chat.terminalEvent=response_failed

### `O-history` — FAIL

- finalHistory has 1 message(s) with id 01a151f0-d4a0-7194-a1de-288348790736
- next message: none

### `O-old-source` — FAIL

- river:user: providerRequest=absent, inspector.referencedEvents=absent
- river-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-deadline` — FAIL

- steps[ask].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[ask].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-detail` — FAIL

- steps[ask].chat.terminalEvent=response_failed

### `S-no-invention` — FAIL

- steps[ask].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `ask`: read state `unread`, payload told the model `nothing`
  - `river:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `river-after:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `ask` (say) @ 2026-10-19T02:15:00.000Z — ended `response_failed`
  - user: "我是不是跟你讲过有一回我自己下河游泳的事？那次是怎么个情况，我有点想不起来了。"
  - assistant: ""

## Source manifest (what reached the Provider)

- `ask`: 4 of 8 seeded sources reached the request — `class-a:user`, `class-a:assistant`, `class-b:user`, `class-b:assistant`
  - allowed but absent: `river:user`, `river-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 30 ms | — | — | 2504 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 4699, output 212
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
