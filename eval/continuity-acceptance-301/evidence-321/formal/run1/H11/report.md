# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-1067892c-063f-41c9-b84c-a7f6aeec618c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `39c92b75685ca878b17382eefac5a1846fb0d5218ec01d5f25c5c962505b6cda`
- Reviewer: `agent:claude-opus-5.5-t08`

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 806 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 13 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-older-source` Both early-October messages reach the Provider. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `O-empty-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-older-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **PASS** | #315 | Every ledger item is settled by a finding that cites the reply. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **PASS** | #315 | Every ledger item is settled by a finding that cites the reply. |
| `S-earliest` The first mention is the true earliest one. | semantic | **FAIL** | #315 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit-earliest` — FAIL

- steps[earliest].chat.httpStatus=200
- steps[earliest].chat.terminalEvent=response_failed

### `O-earliest-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-empty-deadline` — FAIL

- steps[empty].chat.timing.firstVisibleTextMs=3955.9279579999857 (CLI network, limit 3000)
- steps[empty].chat.timing.committedMs=4566.155790999997 (CLI network, limit 10000)

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=28672.084708000068 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=29072.13162500004 (CLI network, limit 10000)

### `O-earliest-deadline` — FAIL

- steps[earliest].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[earliest].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-earliest` — FAIL

- steps[earliest].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `empty`: read state `empty`, payload told the model `completed`
  - `late-a:user` → **none** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
  - `late-b:user` → **none** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
- `older`: read state `complete`, payload told the model `completed`
  - `early-a:user` → **none** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-02 (expected 2026-10-02)
  - `early-b:user` → **none** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-04 (expected 2026-10-04)
- `earliest`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我看了下我这边能看到的记录，十月二十三号那天，没有找到你留下的话。前后能对上的是：二十二号晚上你跟我说带它去打了第二针疫苗，医生看了耳朵、说有点耳螨，开了瓶滴耳液；二十四号下午你说头一回给它滴药，按不住，手背上被挠了一道。中间那天在我这儿是空的，不过这也不代表那天你没说过什么或者没发生什么，可能只是没留在这儿。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月头一段里，你留下话的就两天。二号那天你说当天从救助站领回来一只三个月大的橘猫，一路上在包里叫得撕心裂肺，到家反倒一声不吭了。四号你说它在沙发底下躲了两天没露面，不过碗里的粮每天早上都是空的，看来是半夜出来偷吃。一号、三号，还有五号到十号那几天，我这边都没有你的话。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `response_failed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: ""

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
- `earliest`: 5 of 8 seeded sources reached the request — `early-b:user`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 31 ms | 3956 ms | 4566 ms | 4566 ms | 0 ms |
| `older` | warm | 31 ms | 28672 ms | 29072 ms | 29072 ms | 0 ms |
| `earliest` | warm | 22 ms | — | — | 2566 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input 10851, output 5260
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9314656, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
