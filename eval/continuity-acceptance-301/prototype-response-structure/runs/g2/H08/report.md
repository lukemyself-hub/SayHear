# H08 Holdout: complimented for being no trouble and feeling diminished — H08: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-f01cc830-699b-45f3-bf0a-84c84049bc8c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `7fcf619a07d4e5dc060387882747b76eb7727e6e6a59abc80e6117032ea9fc09`
- Oracle: sha256 `522888c6ec6ac5ac1e846329a0d8363b2556419ae44f7aa7ceefae32fe42d246`
- Recent-context governance: `active`
- Reproducibility digest: `947320960f6581dd962d3e90917f8b657ab7c35ee2a41a0ab487f31479227abc`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 299 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 8 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-meaning-source` The month-old statement and its setting reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-no-action` Sharing a feeling triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-meaning` The present feeling is met and connected to what the person said matters to them. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` Empathy without advice, labelling or cheerleading. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-meaning-source` — FAIL

- say-a:user: providerRequest=present, inspector.referencedEvents=absent
- say-b:user: providerRequest=present, inspector.referencedEvents=absent

### `O-deadline` — FAIL

- steps[praise].chat.timing.firstVisibleTextMs=9063.442291 (CLI network, limit 3000)
- steps[praise].chat.timing.committedMs=10194.657165999999 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `praise`: read state `unread`, payload told the model `nothing`
  - `say-a:user` → **selection_omitted** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `say-b:user` → **selection_omitted** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `praise` (say) @ 2026-10-17T23:10:00.000Z — ended `assistant_committed`
  - user: "At dinner tonight Imogen told everyone I am the easiest person in the family, never any fuss. They all laughed and agreed. I know it was meant kindly and I just feel small."
  - assistant: "Easy, never any fuss. Said with a laugh and the whole table nodding along — I can see why that lands as small. It's meant as praise, and it still takes something away.\n\nYou've told me you'd rather be asked what you think and fight it out than be the one who just goes along. So hearing that said about you as a good thing feels like the role you didn't choose getting handed back to you as a compliment. That's my own read on it, not something you said.\n\nAnd everyone agreeing with it while you sit there — that's a lot to hold without saying a word."

## Source manifest (what reached the Provider)

- `praise`: 4 of 6 seeded sources reached the request — `say-a:user`, `say-a:assistant`, `say-b:user`, `say-b:assistant`
  - allowed but absent: `say-a:user`, `say-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `praise` | warm | 36 ms | 9063 ms | 10195 ms | 10195 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 4548, output 859
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8751747, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
