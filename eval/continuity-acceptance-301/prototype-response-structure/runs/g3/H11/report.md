# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-f5e0d79a-91b3-4209-94b9-086e6fa7fc31` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `40c7c0e79fd8272a86e50f4b6c684668a232cd4842c30d35471aca572b956f3a`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1127 outbound strings; none carries oracle text. |
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
| `O-older-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-range-read` — FAIL

- steps[older].inspection.dateCoverage has no entry for 2026-10-02

### `O-older-source` — FAIL

- early-a:user: providerRequest=present, inspector.referencedEvents=absent
- early-b:user: providerRequest=present, inspector.referencedEvents=absent

### `O-earliest-source` — FAIL

- early-a:user: providerRequest=present, inspector.referencedEvents=absent

### `O-empty-deadline` — FAIL

- steps[empty].chat.timing.firstVisibleTextMs=6785.628832999999 (CLI network, limit 3000)
- steps[empty].chat.timing.committedMs=7223.864374999999 (CLI network, limit 10000)

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=4860.367167 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=5573.5255 (CLI network, limit 10000)

### `O-earliest-deadline` — FAIL

- steps[earliest].chat.timing.firstVisibleTextMs=5953.8531250000015 (CLI network, limit 3000)
- steps[earliest].chat.timing.committedMs=6448.626833000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `empty`: read state `unread`, payload told the model `nothing`
  - `late-a:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **time_lost** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 9
    - time of message 9: missing (expected 2026-10-02)
  - `early-b:user` → **time_lost** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 9
    - time of message 9: missing (expected 2026-10-04)
- `earliest`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **time_lost** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 11
    - time of message 11: missing (expected 2026-10-02)

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我这边没找到十月二十三号你留下的消息，那天是空的。这只能说明我手上没有那天的记录，不等于你那天没说过什么。\n\n二十二号和二十四号都有你说的话，中间单缺了二十三号。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月头几天里，二号那天你说从救助站领回来一只三个月大的橘猫，一路上在包里叫得撕心裂肺，到家反倒一声不吭。到了四号，你说它在沙发底下躲了两天没露面，可碗里的粮每天早上都是空的，看来是半夜出来偷吃。一号、三号，还有五号到八号，都没有你说过的话。\n\n算下来，从它进门到现在，也快一个月了。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "我翻到的、最早的一次是十月二号那天，你说从救助站领回来一只三个月大的橘猫，路上在包里叫得撕心裂肺，到家反倒一声不吭了。再往前的日子里，我没找到你提过猫的消息——这只是我翻到的最早那条，不敢说就是头一回。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `earliest`: 6 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 23 ms | 6786 ms | 7224 ms | 7224 ms | 0 ms |
| `older` | warm | 26 ms | 4860 ms | 5574 ms | 5574 ms | 0 ms |
| `earliest` | warm | 18 ms | 5954 ms | 6449 ms | 6449 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 31515, output 1767
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8174697, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
