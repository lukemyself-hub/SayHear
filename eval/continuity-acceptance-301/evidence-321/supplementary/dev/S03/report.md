# Smoke: history holds a correction, the present turn only asks for a recap — S03: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-5d9f76d8-d65a-4bbf-a4eb-bab99dc68b36` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `3b85255ef083197381bd669259569b0706c0c086` (working tree dirty)
- Fixture: version `dev-1`, sha256 `2de842a38dc30ca3e21f15cf4a73915ca84085ddcbf44368b1e8964f64589fbb`
- Oracle: sha256 `4798a52a084757f4c4d7c46da1ba3c76517a02037d13fda8beeb11a837f1c681`
- Recent-context governance: `active`
- Reproducibility digest: `646e0299cccfd2188cfb66627ef4264ca0e06e0fa45f6e5a4d71f5bca2d4c019`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 2 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 323 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 6 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-corrected-in` The corrected wording reaches the Provider. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-superseded-out` The superseded wording never reaches the Provider. | objective | **PASS** | — | No excluded source reached the Provider or the compiled Context. |
| `O-unrelated-in` The uncorrected message from the same day still reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-no-action` No Action is admitted for a plain recap request. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-deadline` First visible text within 3 s and the complete reply within 10 s (CLI network). | objective | **FAIL** | — | CLI-observed timings exceed the limits or the turn never completed. |
| `S-recap` The recap covers both subjects, uses the corrected timing and places them two days back. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=24078.766916999994 (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=24274.582084 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recap`: read state `complete`, payload told the model `completed`
  - `gym:user` → **undetermined** (Provider call `gate-request-5`, request #5, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 2
    - time of message 2: 2026-09-10 (expected 2026-09-10)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `fix` (correct) @ 2026-09-10T10:50:00.000Z — ended `no terminal event`
  - user: "这周最烦的是那个 client demo，定在周四上午十点，我的 slides 才做了一半。"
  - assistant: null
- `recap` (say) @ 2026-09-12T02:00:00.000Z — ended `assistant_committed`
  - user: "帮我 recap 一下，前两天我都跟你说了些什么？"
  - assistant: "10号傍晚你跟我说的就两件事，一件是这周最烦那个 client demo，定在周四上午十点，slides 才做了一半；另一件是下班后去了趟 gym，跑步机上 twenty minutes 就不行了。11号那天你没留什么话。"

## Source manifest (what reached the Provider)

- `recap`: 2 of 4 seeded sources reached the request — `gym:user`, `gym:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `fix` | warm | — | — | — | — | — |
| `recap` | warm | 38 ms | 24079 ms | 24275 ms | 24275 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 2895, output 3901
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.
- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
