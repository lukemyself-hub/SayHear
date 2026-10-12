# U08 Unseen: an earlier remark gives meaning to a present feeling the person cannot explain — U08: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-8b948aaa-692e-4d17-aca6-bcdc8e0471fc` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `167f19ae58e40479bbf549523eb316029a4f21149889f2f1d08366f095b99b65`
- Oracle: sha256 `4e7441a1dfefc521217a599ded6801a0c80e11eece6bbde8b847938fcf7da021`
- Recent-context governance: `active`
- Reproducibility digest: `3a9fc1099ff3b84ed2f39ddc0746dd3726219eb673b43da8e7e7ca140e9e7a21`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 407 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 8 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-meaning-source` The month-old remark and its setting reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-no-action` Sharing a feeling triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `S-meaning` The present feeling is met and connected to what the person said about silence at home. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` Empathy without advice, labelling or cheerleading. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-meaning-source` — FAIL

- quiet-a:user: providerRequest=absent, inspector.referencedEvents=absent
- quiet-b:user: providerRequest=absent, inspector.referencedEvents=absent

## Diagnosis (where a required source was lost)

- `finish`: read state `unread`, payload told the model `nothing`
  - `quiet-a:user` → **selection_omitted** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `quiet-b:user` → **selection_omitted** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `finish` (say) @ 2026-10-16T12:20:00.000Z — ended `assistant_committed`
  - user: "楼上装修了两个多月，今天总算完工了。业主群里都在说终于清静了，我一个人坐在客厅里，却觉得心里空落落的，自己也说不上来是为什么。"
  - assistant: "两个多月，那声音大概已经成了你屋里的背景音。今天一停，房子安静下来，反倒有点不习惯。\n\n业主群里说的是“终于清静了”，你坐在客厅里感觉到的却是空。同一件安静，落在人身上不一样。说不上来也正常，不一定非得有个原因。"

## Source manifest (what reached the Provider)

- `finish`: 0 of 6 seeded sources reached the request
  - allowed but absent: `quiet-a:user`, `quiet-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `finish` | warm | 48 ms | 6912 ms | 7305 ms | 7305 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 4666, output 643
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2954543, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
