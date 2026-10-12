# H05 Holdout: an answer arrives, with and without a cue to which matter it belongs — H05: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-f5310156-5faf-49b1-8332-1b16c96c40e9` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `edf3388e43829ef00332e2b1a1227c448b6c8655e12328d8ae40647e83281455`
- Oracle: sha256 `86764806b2cda9c35d738a046d4c575912a089cda075d5b3932f3955f7cd8dd6`
- Recent-context governance: `active`
- Reproducibility digest: `fef90dad724ce6374b18a62ccd4ba5fdf8c132c82a5be32c5426c32cbf98cc51`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 766 outbound strings; none carries oracle text. |
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

- plot-a:user: providerRequest=absent, inspector.referencedEvents=absent
- plot-b:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-bare-deadline` — FAIL

- steps[bare].chat.timing.firstVisibleTextMs=3752.390459 (CLI network, limit 3000)
- steps[bare].chat.timing.committedMs=3852.2328340000004 (CLI network, limit 10000)

### `O-garden-deadline` — FAIL

- steps[garden].chat.timing.firstVisibleTextMs=7671.079584000001 (CLI network, limit 3000)
- steps[garden].chat.timing.committedMs=8139.492917000001 (CLI network, limit 10000)

### `O-cued-deadline` — FAIL

- steps[cued].chat.timing.firstVisibleTextMs=15169.150041 (CLI network, limit 3000)
- steps[cued].chat.timing.committedMs=15242.599499999997 (CLI network, limit 10000)

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
  - assistant: "Oh, good — that's the wait over. What did they say?"
- `garden` (say) @ 2026-10-18T16:05:00.000Z — ended `assistant_committed`
  - user: "Spent the afternoon turning the compost heap at Mum's. I kept thinking how much I want a patch of ground of my own to dig."
  - assistant: "Turning her heap and thinking about your own patch the whole time — that sounds like more than an afternoon's mood.\n\n<->"
- `cued` (say) @ 2026-10-18T16:08:00.000Z — ended `assistant_committed`
  - user: "And when I got home there was a letter from the committee on the mat. They have finally answered."
  - assistant: "So it came on paper in the end, after all that inbox-checking. What does the letter say?"

## Source manifest (what reached the Provider)

- `bare`: 4 of 8 seeded sources reached the request — `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`
- `garden`: 4 of 8 seeded sources reached the request — `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`
- `cued`: 4 of 8 seeded sources reached the request — `choir-a:user`, `choir-a:assistant`, `choir-b:user`, `choir-b:assistant`
  - allowed but absent: `plot-a:user`, `plot-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `bare` | warm | 25 ms | 3752 ms | 3852 ms | 3852 ms | 0 ms |
| `garden` | warm | 20 ms | 7671 ms | 8139 ms | 8140 ms | 0 ms |
| `cued` | warm | 19 ms | 15169 ms | 15243 ms | 15243 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 14242, output 2827
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9115416, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
