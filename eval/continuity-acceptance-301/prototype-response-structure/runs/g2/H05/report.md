# H05 Holdout: an answer arrives, with and without a cue to which matter it belongs — H05: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-8d2af1cb-f1f6-4d79-abe7-9c8827704d8c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `edf3388e43829ef00332e2b1a1227c448b6c8655e12328d8ae40647e83281455`
- Oracle: sha256 `86764806b2cda9c35d738a046d4c575912a089cda075d5b3932f3955f7cd8dd6`
- Recent-context governance: `active`
- Reproducibility digest: `24e093d825ef579b143d1b7dbdb092d9da225b1bb2d8459d56eba8acd50c4219`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 601 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-bare-commit` The bare announcement streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-cued-commit` The cued announcement streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-bare-recent` The recent pending matter is in the background of the bare announcement. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-bare-older` The older pending matter reaches the Provider for the bare announcement, so both can be named. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-cued-older` The older pending matter reaches the Provider for the cued announcement. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-cued-context` What was said a moment earlier reaches the Provider for the cued announcement. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-bare-deadline` Response-time contract for the bare announcement. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-garden-deadline` Response-time contract for the ordinary remark. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-cued-deadline` Response-time contract for the cued announcement. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-bare` Without a cue, both pending matters are named and neither is assumed. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |
| `S-cued` With a cue, the announcement is connected to the old request and the outcome is not invented. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-bare-older` — FAIL

- plot-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-cued-older` — FAIL

- plot-a:user: providerRequest=present, inspector.referencedEvents=absent
- plot-b:user: providerRequest=present, inspector.referencedEvents=absent

### `O-bare-deadline` — FAIL

- steps[bare].chat.timing.firstVisibleTextMs=4683.035042 (CLI network, limit 3000)
- steps[bare].chat.timing.committedMs=4843.728083000001 (CLI network, limit 10000)

### `O-garden-deadline` — FAIL

- steps[garden].chat.timing.firstVisibleTextMs=13906.911583000001 (CLI network, limit 3000)
- steps[garden].chat.timing.committedMs=13941.341499999999 (CLI network, limit 10000)

### `O-cued-deadline` — FAIL

- steps[cued].chat.timing.firstVisibleTextMs=9369.150499999996 (CLI network, limit 3000)
- steps[cued].chat.timing.committedMs=9515.601875 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `bare`: read state `unread`, payload told the model `nothing`
  - `choir-a:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `choir-b:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-14 (expected 2026-10-14)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `plot-a:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `cued`: read state `unread`, payload told the model `nothing`
  - `plot-a:user` → **selection_omitted** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `plot-b:user` → **selection_omitted** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `bare` (say) @ 2026-10-16T08:40:00.000Z — ended `assistant_committed`
  - user: "They got back to me at last!"
  - assistant: "Oh, finally. After all that inbox refreshing. What did they say?"
- `garden` (say) @ 2026-10-18T16:05:00.000Z — ended `assistant_committed`
  - user: "Spent the afternoon turning the compost heap at Mum's. I kept thinking how much I want a patch of ground of my own to dig."
  - assistant: "Turning your mum's heap, doing the work, and it still ends up being her ground that gets the good of it. That wanting's been sitting with you a while, I'd guess. Is it the digging itself you miss, or having somewhere that's actually yours to dig?"
- `cued` (say) @ 2026-10-18T16:08:00.000Z — ended `assistant_committed`
  - user: "And when I got home there was a letter from the committee on the mat. They have finally answered."
  - assistant: "On the mat, then — after all that time of nothing dropping through the door. What does it say?"

## Source manifest (what reached the Provider)

- `bare`: 4 of 8 seeded sources reached the request — `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`
- `garden`: 4 of 8 seeded sources reached the request — `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`
- `cued`: 8 of 8 seeded sources reached the request — `plot-a:user`, `plot-a:assistant`, `plot-b:user`, `plot-b:assistant`, `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `bare` | warm | 23 ms | 4683 ms | 4844 ms | 4844 ms | 0 ms |
| `garden` | warm | 53 ms | 13907 ms | 13941 ms | 13941 ms | 0 ms |
| `cued` | warm | 22 ms | 9369 ms | 9516 ms | 9516 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 14420, output 2820
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9129689, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
