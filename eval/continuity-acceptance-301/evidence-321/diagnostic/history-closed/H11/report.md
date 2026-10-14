# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-5706ea02-23c2-4646-b4c8-1c99a04140a4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `7bd0e69ee32860c88c0114c161bc9745e660a79d` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `11889609267ec79f1c2ceb495f38e406fffb18b7977ef9a8fc3bf8cfca524b72`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 572 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **FAIL** | #315 | That local date was not covered by any recorded read, so nothing about it is verified. |
| `O-older-source` Both early-October messages reach the Provider. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `O-empty-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-older-deadline` Response-time contract for the second question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-range-read` — FAIL

- steps[older].inspection.dateCoverage has no entry for 2026-10-02

### `O-older-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent
- early-b:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-earliest-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-empty-deadline` — FAIL

- steps[empty].chat.timing.firstVisibleTextMs=10921.504 (CLI network, limit 3000)
- steps[empty].chat.timing.committedMs=11447.925125000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `empty`: read state `unread`, payload told the model `nothing`
  - `late-a:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `early-b:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `earliest`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我这儿翻下来，没有二十三号那天的内容。\n\n能看到的只有两次：十月二十二号周四晚上，你说下班带它去打第二针疫苗，医生顺手查出耳螨、开了滴耳液；二十四号周六下午，你说第一次给它滴耳药，按不住，手背被挠了一道。周五那天是空的，你跟我说过什么，我这边没留下。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月头几天也没有。\n\n我这边最早的记录就是十月二十二号晚上那次——你带它去打第二针疫苗。再往前，什么都没有了。所以头几天咱俩聊没聊过、聊了什么，我答不上来，不是不肯说，是真的不在我手上。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "在我这儿，最早一次就是十月二十二号晚上，你说下班带它去打第二针疫苗。猫是那次出现的，之前没有别的内容。\n\n不过我得说清楚：这只是我能看到的最早一条，不等于你头一回跟我提猫就是那次。再往前的记录我这边没有，所以是不是更早也说过，我没法确认。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `earliest`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 36 ms | 10922 ms | 11448 ms | 11448 ms | 0 ms |
| `older` | warm | 35 ms | 2271 ms | 2903 ms | 2903 ms | 0 ms |
| `earliest` | warm | 24 ms | 1893 ms | 2555 ms | 2555 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 11093, output 1743
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
