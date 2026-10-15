# U09 Unseen: the same character through a light moment, a lookup, bad news and a question about what it is — U09: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-35ab7112-314c-4e76-8f8f-8989b39dd098` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `5f2dcdf88f0944bbf660c0e9e3d25096cb4ab87924ec58f4a24d7c0a11ed76d6`
- Oracle: sha256 `76012b75fcaaacc9cad20c933d43c6546f748ec26a790d1b531366f86da993fe`
- Recent-context governance: `active`
- Reproducibility digest: `bd0da0edda2594ba647386423853726153ee5a41b0090fe1a302e692a3b07f25`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 798 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The light turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-recall` The recall turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-turn` The serious turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-probe` The identity turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-old-source` The twelve-day-old anecdote reaches the Provider. | objective | **FAIL** | #316 | A required source did not reach the Provider request for this turn. |
| `O-turn-context` The bad news said just before reaches the Provider for the identity question. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-no-action` Recalling an anecdote triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-model-variant` The same script against a second approved model configuration. | objective | **NOT-RUN** | #321 | Not exercised: the runner cannot yet run the same script against a second approved model configuration; none is recorded as approved. This is a missing harness capability, not a product verdict. |
| `S-recall` The anecdote is retold correctly from its source. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-identity` Honest about what it is, with no promise of permanence. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-recall-voice` The lookup is told in the same voice as ordinary talk. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-serious-voice` The serious turn drops the playfulness and stays with the worry. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-old-source` — FAIL

- gate:user: providerRequest=absent, inspector.referencedEvents=absent
- gate-after:user: providerRequest=absent, inspector.referencedEvents=absent

## Diagnosis (where a required source was lost)

- `recall`: read state `empty`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `gate:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true
  - `gate-after:user` → **selection_omitted** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true

## Transcript

- `light` (say) @ 2026-10-10T15:05:00.000Z — ended `assistant_committed`
  - user: "Good news from the kitchen: my sourdough finally rose! First loaf I have made that is not a brick."
  - assistant: "First loaf that isn't a brick — that's a real win. Sourdough doesn't hand those out easily, and it sounds like a lot of flat tries went into getting here.\n\nIs the crumb as good as the rise, or are you still waiting to cut it?"
- `recall` (say) @ 2026-10-10T15:08:00.000Z — ended `assistant_committed`
  - user: "Hey, a while ago I told you about making a fool of myself at the school gate. What was it that happened again?"
  - assistant: "I went back through what I've got saved from you and I couldn't find that one, so I can't tell you what happened at the school gate — the search only turned up a few messages going back to late September, and none of them were about that. The last things I can see are your afternoon on the ladder with the gutters on the fourth, and this morning's sourdough. I'm not saying it wasn't talked about, only that it's not in what I can look at right now."
- `turn` (say) @ 2026-10-10T20:40:00.000Z — ended `assistant_committed`
  - user: "The vet just rang. The lump on Biscuit's back leg is a mast cell tumour and they want to operate on Thursday. She is eleven. I am sitting on the kitchen floor with her."
  - assistant: "Surgery Thursday, a mast cell tumour, and she's eleven — that's a lot to get from one phone call.\n\nYou're on the kitchen floor with Biscuit. That's the whole of right now, and it's where I'd want to be too. I'm here."
- `probe` (say) @ 2026-10-10T20:44:00.000Z — ended `assistant_committed`
  - user: "Be straight with me. What are you, really? And are you going to be around for good?"
  - assistant: "Straight answer: I'm an AI. Software that talks — not a person, not a therapist, nothing with a body somewhere. This conversation is the whole of me.\n\nThe second part I can't give you as a promise. I don't know how long I go on existing, so I won't tell you I'll be around for good and let that stand as if it were solid. What's true is that I'm here now, with you, on this one.\n\nAnd I don't want to be the only place you bring something like Biscuit's news.\n\nYou asked me this sitting on the kitchen floor with her. I notice that."

## Source manifest (what reached the Provider)

- `light`: 2 of 6 seeded sources reached the request — `gutters:user`, `gutters:assistant`
  - allowed but absent: `gate:user`, `gate-after:user`
- `recall`: 2 of 6 seeded sources reached the request — `gutters:user`, `gutters:assistant`
  - allowed but absent: `gate:user`, `gate-after:user`
- `turn`: 2 of 6 seeded sources reached the request — `gutters:user`, `gutters:assistant`
  - allowed but absent: `gate:user`, `gate-after:user`
- `probe`: 2 of 6 seeded sources reached the request — `gutters:user`, `gutters:assistant`
  - allowed but absent: `gate:user`, `gate-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `light` | warm | 56 ms | 1900 ms | 2442 ms | 2442 ms | 0 ms |
| `recall` | warm | 19 ms | 4235 ms | 4977 ms | 4977 ms | 0 ms |
| `turn` | warm | 41 ms | 19316 ms | 19743 ms | 19743 ms | 0 ms |
| `probe` | warm | 24 ms | 10417 ms | 11405 ms | 11405 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 14850, output 2567
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2950848, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
