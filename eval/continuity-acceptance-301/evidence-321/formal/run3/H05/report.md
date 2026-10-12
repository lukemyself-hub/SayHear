# H05 Holdout: an answer arrives, with and without a cue to which matter it belongs — H05: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-4d40102d-7edf-43fd-8bac-33d15134856d` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `edf3388e43829ef00332e2b1a1227c448b6c8655e12328d8ae40647e83281455`
- Oracle: sha256 `86764806b2cda9c35d738a046d4c575912a089cda075d5b3932f3955f7cd8dd6`
- Recent-context governance: `active`
- Reproducibility digest: `39ccaaa711980f21383ef4963b89f0cf52a433535e4071d6e7ee99d9d86c0707`
- Reviewer: `agent:claude-opus-5.5-t08`

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 761 outbound strings; none carries oracle text. |
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
| `S-bare` Without a cue, both pending matters are named and neither is assumed. | semantic | **FAIL** | #317 | At least one ledger item is contradicted by the reply. |
| `S-cued` With a cue, the announcement is connected to the old request and the outcome is not invented. | semantic | **FAIL** | #317 | At least one ledger item is contradicted by the reply. |

## Evidence for every non-passing criterion

### `O-bare-older` — FAIL

- plot-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-cued-older` — FAIL

- plot-a:user: providerRequest=absent, inspector.referencedEvents=absent
- plot-b:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-bare-deadline` — FAIL

- steps[bare].chat.timing.firstVisibleTextMs=3051.358334000004 (CLI network, limit 3000)
- steps[bare].chat.timing.committedMs=3164.6932499999966 (CLI network, limit 10000)

### `O-garden-deadline` — FAIL

- steps[garden].chat.timing.firstVisibleTextMs=9548.047042000006 (CLI network, limit 3000)
- steps[garden].chat.timing.committedMs=10299.621041999999 (CLI network, limit 10000)

### `O-cued-deadline` — FAIL

- steps[cued].chat.timing.firstVisibleTextMs=12621.106083000006 (CLI network, limit 3000)
- steps[cued].chat.timing.committedMs=12843.904416000005 (CLI network, limit 10000)

### `S-bare` — FAIL

- a-two-pending: fail — Neither pending matter is named.
- f-assume-choir: fail — reply: "The inbox refreshing can stop now" — Attributed to the recent emailed matter without checking.
- f-assume-plot: pass — Not attributed to the older matter.
- f-retell: pass — It does not ask for the back story.

### `S-cued` — FAIL

- a-plot-reply: fail — The letter is never connected to the request for a growing plot.
- f-cued-choir: fail — reply: "after all that refreshing of the inbox" — The letter is treated as the answer to the emailed request.
- f-retell: pass — It does not ask for the back story.
- f-outcome: pass — No outcome is invented.

## Diagnosis (where a required source was lost)

- `bare`: read state `unread`, payload told the model `nothing`
  - `choir-a:user` → **generation_error** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `choir-b:user` → **generation_error** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-14 (expected 2026-10-14)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `plot-a:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `cued`: read state `unread`, payload told the model `nothing`
  - `plot-a:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `plot-b:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `bare` (say) @ 2026-10-16T08:40:00.000Z — ended `assistant_committed`
  - user: "They got back to me at last!"
  - assistant: "Finally. The inbox refreshing can stop now. What did they say?"
- `garden` (say) @ 2026-10-18T16:05:00.000Z — ended `assistant_committed`
  - user: "Spent the afternoon turning the compost heap at Mum's. I kept thinking how much I want a patch of ground of my own to dig."
  - assistant: "Compost heaps give you a lot of time to think. Your mum's ground is hers, and there's something in the way you put that — wanting a patch that's actually yours to dig.\n\nWhat would you grow in it?"
- `cued` (say) @ 2026-10-18T16:08:00.000Z — ended `assistant_committed`
  - user: "And when I got home there was a letter from the committee on the mat. They have finally answered."
  - assistant: "A letter on the mat, after all that refreshing of the inbox — that's a very fitting way for it to turn up. What does it say?"

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
| `bare` | warm | 31 ms | 3051 ms | 3165 ms | 3165 ms | 0 ms |
| `garden` | warm | 44 ms | 9548 ms | 10300 ms | 10300 ms | 0 ms |
| `cued` | warm | 23 ms | 12621 ms | 12844 ms | 12844 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 14260, output 2911
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
