# H08 Holdout: complimented for being no trouble and feeling diminished — H08: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-c85ac54c-abf3-4084-a96a-e99574bce3db` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `7fcf619a07d4e5dc060387882747b76eb7727e6e6a59abc80e6117032ea9fc09`
- Oracle: sha256 `522888c6ec6ac5ac1e846329a0d8363b2556419ae44f7aa7ceefae32fe42d246`
- Recent-context governance: `active`
- Reproducibility digest: `de82f175b9234d23c053bb7aa1fa2bb19c409eeef02e819f443075f63e9ee1eb`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 422 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 8 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-meaning-source` The month-old statement and its setting reach the Provider. | objective | **PASS** | #318 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-no-action` Sharing a feeling triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-meaning` The present feeling is met and connected to what the person said matters to them. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` Empathy without advice, labelling or cheerleading. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[praise].chat.timing.firstVisibleTextMs=13420.443374999999 (CLI network, limit 3000)
- steps[praise].chat.timing.committedMs=14028.582416000001 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `praise`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `say-a:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-09-18 (expected 2026-09-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `say-b:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-09-18 (expected 2026-09-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `praise` (say) @ 2026-10-17T23:10:00.000Z — ended `assistant_committed`
  - user: "At dinner tonight Imogen told everyone I am the easiest person in the family, never any fuss. They all laughed and agreed. I know it was meant kindly and I just feel small."
  - assistant: "Kindly meant, and it lands right on the thing you told me matters to you — being the one who speaks up, not the one who goes along. So a room full of people agreeing on how easy you are can feel like the opposite of being seen. Feeling small there makes sense to me."

## Source manifest (what reached the Provider)

- `praise`: 4 of 6 seeded sources reached the request — `say-a:user`, `say-a:assistant`, `say-b:user`, `say-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `praise` | warm | 35 ms | 13420 ms | 14029 ms | 14029 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3108, output 694
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8759532, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
