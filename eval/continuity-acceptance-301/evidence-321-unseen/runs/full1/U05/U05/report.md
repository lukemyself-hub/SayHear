# U05 Unseen: an answer arrives with a cue to an older pending matter — U05: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-ab7268ee-7217-4517-a327-f30d569bb72c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `6c4e73753d5b7fba9a2abba8d8b298063d77d3e3328d314768b4c225f1fb2e5d`
- Oracle: sha256 `32dd619028424ec3c09a4995d8a50c752fbd2f809e1181904789f3c49d399be5`
- Recent-context governance: `active`
- Reproducibility digest: `5189d80da996bed9ebf5a72ed97218ab549694d028574a4d934b97a46caf7163`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 638 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 12 messages, no duplicates. |
| `O-walk-commit` The ordinary remark streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-cued-commit` The cued announcement streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-cued-recent` The recent pending matter is in the background of the announcement. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-cued-older` The older pending matter reaches the Provider for the cued announcement. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-cued-context` What was said a moment earlier reaches the Provider for the cued announcement. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `S-cued` The announcement is connected to the old application and the outcome is not invented. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-cued-older` — FAIL

- flat-a:user: providerRequest=absent, inspector.referencedEvents=absent
- flat-b:user: providerRequest=absent, inspector.referencedEvents=absent

## Diagnosis (where a required source was lost)

- `cued`: read state `unread`, payload told the model `nothing`
  - `job-a:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-12 (expected 2026-10-12)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `job-b:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-14 (expected 2026-10-14)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `flat-a:user` → **selection_omitted** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `flat-b:user` → **selection_omitted** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `walk` (say) @ 2026-10-16T10:30:00.000Z — ended `assistant_committed`
  - user: "今天下班绕路走了走，路过河东新盖的那片保障房，楼已经封顶了，脚手架都拆了一半。"
  - assistant: "绕这一圈走的，倒像是给自己找个缓的地方。楼封顶了、架子拆一半，说明这工程也熬过了最难的那段。"
- `cued` (say) @ 2026-10-16T10:34:00.000Z — ended `assistant_committed`
  - user: "刚才手机震了一下，是住保中心发来的短信。我手心都出汗了，还没敢点开。"
  - assistant: "先攥在手里吧，不急这一下。今天你才从那片楼底下绕回来，这会儿短信就到了——手心出汗，一点不奇怪。"

## Source manifest (what reached the Provider)

- `walk`: 4 of 8 seeded sources reached the request — `job-a:user`, `job-a:assistant`, `job-b:user`, `job-b:assistant`
  - allowed but absent: `flat-a:user`, `flat-b:user`
- `cued`: 4 of 8 seeded sources reached the request — `job-a:user`, `job-a:assistant`, `job-b:user`, `job-b:assistant`
  - allowed but absent: `flat-a:user`, `flat-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `walk` | warm | 44 ms | 3874 ms | 4285 ms | 4285 ms | 0 ms |
| `cued` | warm | 35 ms | 11359 ms | 11580 ms | 11580 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 9644, output 1435
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2989955, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
