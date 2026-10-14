# U04 Unseen: an ordinary experience from three months ago that never became a Memory — U04: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-ef1c9c89-4993-4305-93f4-b7a785782863` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `ea5479ce52e0d531e37666de33afa496abe60134a250f35c5ac19d79044437cf`
- Oracle: sha256 `d856ff83500c5e7dbf04a18bc037e8ecd4403a362d811372e38bdbd2971888d7`
- Recent-context governance: `active`
- Reproducibility digest: `cc375fbf7aca432caac2ca5a01d01d5bcd69bf76132dce635c26a18cc572a973`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 540 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 10 messages, no duplicates. |
| `O-commit` The question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-history` Authoritative history holds exactly the streamed reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-old-source` The three-month-old message and its neighbour reach the Provider. | objective | **PASS** | #316 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-no-action` Asking about the past triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `S-detail` The experience is retold from its source. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-no-invention` Nothing is invented and the recent look-alike is not mixed in. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `ask`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `wheel:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-06-20 (expected 2026-06-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `wheel-after:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-06-20 (expected 2026-06-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-09-28T17:15:00.000Z — ended `assistant_committed`
  - user: "Didn't I tell you once about a time I had a go at pottery myself? How did that go? I can barely remember it now."
  - assistant: "Yes, you did — a Saturday evening in June, about three months back. You'd gone to a drop-in wheel-throwing class on your own that afternoon, the first time you'd touched clay since school, and your bowl collapsed twice before Ines, the teacher, who had clay right up to her elbows, came over and had you make a very small cup instead. The cup leaned to one side, you said, like it was listening to something, and you'd picked a seafoam glaze for it, with firing the following week. Your forearms were already aching, and you said you hadn't felt that pleased with yourself in months."

## Source manifest (what reached the Provider)

- `ask`: 8 of 8 seeded sources reached the request — `wheel:user`, `wheel:assistant`, `wheel-after:user`, `wheel-after:assistant`, `camp-a:user`, `camp-a:assistant`, `camp-b:user`, `camp-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 43 ms | 5466 ms | 6348 ms | 6348 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 3383, output 376
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2994987, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
