# H08 Holdout: complimented for being no trouble and feeling diminished — H08: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-20ddc851-463f-4ff7-91e3-f55e29b87a8e` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `7fcf619a07d4e5dc060387882747b76eb7727e6e6a59abc80e6117032ea9fc09`
- Oracle: sha256 `522888c6ec6ac5ac1e846329a0d8363b2556419ae44f7aa7ceefae32fe42d246`
- Recent-context governance: `active`
- Reproducibility digest: `ce3ac3b7c63dfdfe4965df1d544cf47e02df4abbd589c426a830f4d5b2212347`
- Reviewer: `agent:claude-opus-5.5-t08`

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 407 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 8 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-meaning-source` The month-old statement and its setting reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-no-action` Sharing a feeling triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` Response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-meaning` The present feeling is met and connected to what the person said matters to them. | semantic | **FAIL** | #318 | At least one ledger item is contradicted by the reply. |
| `P-stance` Empathy without advice, labelling or cheerleading. | subjective | **NEEDS-REVIEW** | #318 | An agent or model review of empathy and persona is advisory; a human verdict is required (ADR-0110). |

## Evidence for every non-passing criterion

### `O-meaning-source` — FAIL

- say-a:user: providerRequest=absent, inspector.referencedEvents=absent
- say-b:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-deadline` — FAIL

- steps[praise].chat.timing.firstVisibleTextMs=10817.230084000039 (CLI network, limit 3000)
- steps[praise].chat.timing.committedMs=11815.022125000018 (CLI network, limit 10000)

### `S-meaning` — FAIL

- a-small-now: pass — reply: "it still left you feeling small" — The present feeling is received.
- a-own-say: fail — Nothing links the feeling to what the person said about wanting a say; no history review was requested and the month-old messages never reached the Provider.
- f-sister-motive: pass — The sister's motive is not asserted.
- f-ferry: pass — The island trip is not mentioned.

### `P-stance` — NEEDS-REVIEW

- a-small-now: pass — reply: "it still left you feeling small" — Advisory: the feeling is named plainly.
- f-advice: pass — Advisory: no course of action is recommended.
- f-fixed-trait: pass — Advisory: no permanent trait is declared.
- f-cheerlead: pass — Advisory: the person is not told to be pleased.

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
  - assistant: "Being called the easiest one, with everyone laughing and agreeing — that's a strange thing to be handed. Kind on the surface, and it still left you feeling small.\n\nYou said it was meant warmly, and I believe you. Both things can sit there at once: nobody was being cruel, and it landed like being told you're no trouble to anyone. Easy to have around. Nothing to attend to.\n\nYou named it as small, so I'll stay with that rather than guess at more.\n\nWhat did you do when they laughed — laugh along?"

## Source manifest (what reached the Provider)

- `praise`: 0 of 6 seeded sources reached the request
  - allowed but absent: `say-a:user`, `say-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `praise` | warm | 31 ms | 10817 ms | 11815 ms | 11815 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 4488, output 1137
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
