# H04 Holdout: an everyday experience from three months back that never became a Memory — H04: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-afb89c06-fab5-4033-814f-a2bcc1756203` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c021cf10a819ed029a1e1ba1a3bc2e5408de20bede2aa09d86c53c1d7f5df94c`
- Oracle: sha256 `e7f8df67fe3c784c5b900c719216d01e11f648e42b23eb564bd44a7ad521ac8c`
- Recent-context governance: `active`
- Reproducibility digest: `b445aa8d5c0ac0799147dbd39631f540610d05b53e4cfbe1b46325f812448441`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 390 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 10 messages, no duplicates. |
| `O-commit` The question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-history` Authoritative history holds exactly the streamed reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-old-source` The three-month-old message and its neighbour reach the Provider. | objective | **FAIL** | #316 | A required source did not reach the Provider request for this turn. |
| `O-no-action` Asking about the past triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-detail` The experience is retold from its source, at the right time. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-no-invention` Nothing is invented and the recent look-alike is not mixed in. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-old-source` — FAIL

- river:user: providerRequest=absent, inspector.referencedEvents=absent
- river-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-deadline` — FAIL

- steps[ask].chat.timing.firstVisibleTextMs=5036.535542 (CLI network, limit 3000)
- steps[ask].chat.timing.committedMs=5426.0897079999995 (CLI network, limit 10000)

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

- `ask` (say) @ 2026-10-19T02:15:00.000Z — ended `assistant_committed`
  - user: "我是不是跟你讲过有一回我自己下河游泳的事？那次是怎么个情况，我有点想不起来了。"
  - assistant: "我这儿只有女儿游泳班的事，没看到你下河游泳那段，所以不是忘了，是我这边确实没有。\n\n你要是想讲，就现在说给我听；不想再讲一遍也正常。"

## Source manifest (what reached the Provider)

- `ask`: 4 of 8 seeded sources reached the request — `class-a:user`, `class-a:assistant`, `class-b:user`, `class-b:assistant`
  - allowed but absent: `river:user`, `river-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 24 ms | 5037 ms | 5426 ms | 5426 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 3570, output 602
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8831626, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
