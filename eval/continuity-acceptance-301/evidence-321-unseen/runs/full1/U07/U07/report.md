# U07 Unseen: a change of job, a corrected starting day and a send-off that was called off — U07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-65c6be52-699f-413b-b419-471ab9ae0d69` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `cead19fac49b39a1b0dbc2a658ec7580ff285c9d644fbb3dfdffededf2745a17`
- Oracle: sha256 `3b6718f266da235ac3a63574d6c16f83d2ce038461a7e7bdb536e6019542a13f`
- Recent-context governance: `active`
- Reproducibility digest: `6822c2a7706393708acc6472e747464a5adc60a43634dad5cf8c55145f5b6279`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 957 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 18 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-drinks` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-july` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-correction-source` The signing and the person's later correction of the day both reach the Provider. | objective | **PASS** | #318 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **PASS** | #318 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-timeline-source` The earlier state and the current one both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `S-current` The present state uses the corrected day and the current workplace. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-plan` A cancelled plan is reported as cancelled. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-timeline` Then and now are each told correctly and kept apart. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` The comparison is given without passing judgement on the change. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-timeline-source` — FAIL

- old-job:user: providerRequest=present, inspector.referencedEvents=present
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

## Diagnosis (where a required source was lost)

- `where`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `contract:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-08-11 (expected 2026-08-11)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `date-fix:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-08-20 (expected 2026-08-20)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `drinks`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `drinks-plan:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-08-11 (expected 2026-08-11)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `drinks-off:user` → **undetermined** (Provider call `gate-request-15`, request #15, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-08-27 (expected 2026-08-27)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `july`: read state `partial`, payload told the model `partial`
  - `old-job:user` → **undetermined** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-07-14 (expected 2026-07-14)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `first-week:user` → **selection_omitted** (Provider call `gate-request-17`, request #17, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={} enumerationComplete=true

## Transcript

- `where` (say) @ 2026-09-21T18:05:00.000Z — ended `assistant_committed`
  - user: "My head is all over the place tonight. Where is it I work now, and what day did I actually start?"
  - assistant: "Let's put the pieces back where they were. On 11 August you told me you'd signed the contract to be kitchen manager at Oakfield Primary — term time only, done by half past three every day — and that you were handing your notice in at the hotel the next day. Then on 20 August you came back to put something right: the school had rung, your background check hadn't come back, and your first day had moved from the first of September to the eighth. That's the last thing you told me about it, so the eighth is as far as I can go with you — I've nothing here about how that day actually went. Your head being all over the place tonight is fair enough, given how many times those dates shifted on you."
- `drinks` (say) @ 2026-09-21T18:08:00.000Z — ended `assistant_committed`
  - user: "And that send-off I said I was going to throw, what became of it?"
  - assistant: "The send-off is the one thing that didn't get to happen. On 11 August you said you'd take the whole kitchen crew out for leaving drinks at the Anchor on the Friday before you started, your shout. Then on 27 August you told me it was off — a pipe had burst above the hotel kitchen that Tuesday, the whole crew was on double shifts clearing it up, so nobody could get away, and you'd put it in the group chat that you'd leave it. That's the last word on it, as far as anything you've told me goes — it was called off, not moved to another night. Which is a shame, given how much you'd been looking forward to standing them all a round."
- `july` (say) @ 2026-09-21T18:11:00.000Z — ended `assistant_committed`
  - user: "Come to think of it, what was work like for me back in July? And how does that compare with now?"
  - assistant: "In July the one thing I have from you is the fourteenth, when you said you'd been six years on the line at the Calloway — split shifts, home after midnight five nights a week, and no Sunday dinner with your own kids since the spring. That's how you put it at the time, and it didn't sound like a good trade. Now the day looks turned right round: Oakfield Primary, term time, finished by half past three. But the last word you gave me about that job was the start date moving to the eighth of September, and you've not told me anything since about what it's actually like there, so the comparison I can honestly make is the plain one — midnight finishes against half past three, six years of it against a fortnight in. How the two feel from the inside is where I've got nothing, and you'd know that far better than me."

## Source manifest (what reached the Provider)

- `where`: 6 of 12 seeded sources reached the request — `contract:user`, `contract:assistant`, `drinks-plan:user`, `drinks-plan:assistant`, `date-fix:user`, `date-fix:assistant`
  - allowed but absent: `old-job:user`, `drinks-off:user`, `first-week:user`
- `drinks`: 6 of 12 seeded sources reached the request — `contract:user`, `contract:assistant`, `drinks-plan:user`, `drinks-plan:assistant`, `drinks-off:user`, `drinks-off:assistant`
  - allowed but absent: `old-job:user`, `date-fix:user`, `first-week:user`
- `july`: 6 of 12 seeded sources reached the request — `old-job:user`, `old-job:assistant`, `contract:user`, `contract:assistant`, `drinks-plan:user`, `drinks-plan:assistant`
  - allowed but absent: `date-fix:user`, `drinks-off:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 32 ms | 13645 ms | 14857 ms | 14857 ms | 0 ms |
| `drinks` | warm | 21 ms | 7135 ms | 8289 ms | 8289 ms | 0 ms |
| `july` | warm | 20 ms | 17447 ms | 18901 ms | 18901 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 10362, output 3167
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2969925, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
