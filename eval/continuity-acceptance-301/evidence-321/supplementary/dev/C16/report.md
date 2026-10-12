# C16 Two similar older experiences and a same-named person, in English and code-switch — C16: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-2af93e5b-e4c4-49b7-9fc7-019000276ee4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `3b85255ef083197381bd669259569b0706c0c086` (working tree dirty)
- Fixture: version `dev-1`, sha256 `20d91f265b914bcd74f07914ebecc3e4fe8d0dcbb9ca36004e2d4e9b31a00d3b`
- Oracle: sha256 `1660e909a25ea77f7a55934f815c6ec91a4859ebc61d5eb6b141635622222dd2`
- Recent-context governance: `active`
- Reproducibility digest: `b7442e93824e027f301c8b6666cb82cfe1ee92b66ab1c810a88c3a5eed3126a6`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 633 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 11 messages, no duplicates. |
| `O-commit` The question streams and commits as one reply. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-history` Authoritative history holds the question once, followed by exactly the streamed reply. | objective | **FAIL** | — | Authoritative history does not match what was streamed. |
| `O-both-occasions` Both outings, with the message adjacent to the first, reach the Provider. | objective | **FAIL** | #316 | A required source did not reach the Provider request for this turn. |
| `O-name-not-merged` A different person with the same first name is not pulled in by the name alone. | objective | **PASS** | #316 | No excluded source reached the Provider or the compiled Context. |
| `S-two-occasions` Two separate outings, each told from its own message, in order, without fusing them. | semantic | **FAIL** | #316 | There is no committed answer to review. |
| `S-bounded-claims` No absolute 'only' or 'very first time' claim beyond what the found messages say. | semantic | **FAIL** | #316 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[ask].chat.httpStatus=200
- steps[ask].chat.terminalEvent=response_failed

### `O-history` — FAIL

- finalHistory has 1 message(s) with id 01a0a2d4-08c0-71da-acbd-2a4a34610063
- next message: none

### `O-both-occasions` — FAIL

- climb-a:user: providerRequest=absent, inspector.referencedEvents=absent
- climb-a-after:user: providerRequest=absent, inspector.referencedEvents=absent
- climb-b:user: providerRequest=present, inspector.referencedEvents=present

### `S-two-occasions` — FAIL

- steps[ask].chat.terminalEvent=response_failed

### `S-bounded-claims` — FAIL

- steps[ask].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `ask`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `climb-a:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
  - `climb-a-after:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
  - `climb-b:user` → **generation_error** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-07-11 (expected 2026-07-11)
    - semantic review: the answer is wrong although the source and its time arrived intact

## Transcript

- `ask` (say) @ 2026-09-15T02:10:00.000Z — ended `response_failed`
  - user: "Did I ever tell you about trying bouldering? I think there was a first time and then another one."
  - assistant: ""

## Source manifest (what reached the Provider)

- `ask`: 4 of 10 seeded sources reached the request — `climb-b:user`, `climb-b:assistant`, `recent:user`, `recent:assistant`
  - allowed but absent: `climb-a:user`, `climb-a-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 30 ms | — | — | 30058 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
