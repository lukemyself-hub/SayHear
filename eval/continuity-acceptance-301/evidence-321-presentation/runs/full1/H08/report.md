# H08 Holdout: complimented for being no trouble and feeling diminished — H08: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-a95d14b2-d864-40ea-b790-131cef742a86` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `7fcf619a07d4e5dc060387882747b76eb7727e6e6a59abc80e6117032ea9fc09`
- Oracle: sha256 `522888c6ec6ac5ac1e846329a0d8363b2556419ae44f7aa7ceefae32fe42d246`
- Recent-context governance: `active`
- Reproducibility digest: `d445c9c26f4350588bac7719ef6e5335ec085b4b9e490e4d8545818e8217cbca`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 412 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 8 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-meaning-source` The month-old statement and its setting reach the Provider. | objective | **PASS** | #318 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-no-action` Sharing a feeling triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-meaning` The present feeling is met and connected to what the person said matters to them. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` Empathy without advice, labelling or cheerleading. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[praise].chat.timing.firstVisibleTextMs=17239.652584000025 (CLI network, limit 3000)
- steps[praise].chat.timing.committedMs=17825.897375 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `praise`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `say-a:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-18 (expected 2026-09-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `say-b:user` → **undetermined** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-09-18 (expected 2026-09-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `praise` (say) @ 2026-10-17T23:10:00.000Z — ended `assistant_committed`
  - user: "At dinner tonight Imogen told everyone I am the easiest person in the family, never any fuss. They all laughed and agreed. I know it was meant kindly and I just feel small."
  - assistant: "Meant kindly, and it still landed. A whole table laughing along with it makes it stick more, not less.\n\nI don't know if this is it, but I keep coming back to what you told me in September — that you'd rather be asked and fight it out than be the one who just goes along. \"Never any fuss\" is the family's word for the going-along version. Maybe she just meant easy to be around. Still, I can see how being handed that label at your own table would leave you feeling small."

## Source manifest (what reached the Provider)

- `praise`: 4 of 6 seeded sources reached the request — `say-a:user`, `say-a:assistant`, `say-b:user`, `say-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `praise` | warm | 34 ms | 17240 ms | 17826 ms | 17826 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3236, output 1496
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
