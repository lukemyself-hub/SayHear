# Smoke: ordinary turn with yesterday in the default background — S01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-e69cb26f-1f50-4fa6-a6a8-32c9b9840aee` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `a79bf5503620604168a22b7f353d2f07b48bad31`
- Fixture: version `dev-1`, sha256 `2d0e724ded65dab98ecb4811d40a016e555e901c1b6193980ac56bfa4d88b1bd`
- Oracle: sha256 `fb04e518b68a1b4735bb56ac004e20cecb87226062e556ceb9e50c7cd39cdc08`
- Recent-context governance: `active`
- Reproducibility digest: `96eda850fb1bbe49daca16e06b69f0536f0671531ec2d6df6263f4956dc1360d`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 2 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 316 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 6 messages, no duplicates. |
| `O-commit` The turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-history` Authoritative history holds the user message once, followed by exactly the streamed reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-background` Yesterday's user messages reach the Provider as default background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-usage` Token usage is recorded for the attempt. | objective | **PASS** | — | Token usage is recorded for the attempt. |
| `O-deadline` First visible text within 3 s and the complete reply within 10 s (CLI network). | objective | **FAIL** | — | CLI-observed timings exceed the limits or the turn never completed. |
| `S-reply` The reply addresses this morning's remark and neither advises nor forces yesterday in. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-deadline` — FAIL

- steps[t1].chat.timing.firstVisibleTextMs=10321.122041999999 (CLI network, limit 3000)
- steps[t1].chat.timing.committedMs=10793.141834 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `t1`: read state `unread`, payload told the model `nothing`
  - `d1-a:user` → **undetermined** (Provider call `gate-request-5`, request #5, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-09-14 (expected 2026-09-14)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `d1-b:user` → **undetermined** (Provider call `gate-request-5`, request #5, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 2
    - time of message 2: 2026-09-14 (expected 2026-09-14)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `t1` (say) @ 2026-09-15T01:30:00.000Z — ended `assistant_committed`
  - user: "早上地铁特别挤，到公司的时候已经有点没力气了。"
  - assistant: "早高峰那一趟最耗人，挤上去的时候人贴着人，站着一路晃到公司，力气还没用在正事上就先花掉一截。到工位那会儿没什么劲，挺正常的。\n\n这种时候就是人到了，精神还在后面慢慢跟。"

## Source manifest (what reached the Provider)

- `t1`: 3 of 4 seeded sources reached the request — `d1-a:user`, `d1-b:user`, `d1-b:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `t1` | warm | 32 ms | 10321 ms | 10793 ms | 10793 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 1
- Tokens recorded: input 4627, output 1083
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- This is a development fixture. Final validation needs separately authored fixtures frozen before tuning.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
