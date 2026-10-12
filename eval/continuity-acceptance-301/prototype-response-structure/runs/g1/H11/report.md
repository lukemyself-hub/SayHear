# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-70c9a1b9-4189-4ed8-9d08-1e81dcc28f90` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `c09115b46a5a07dd73de11cac9ffe3850e905417a62ebc93ab324e07afa7feac`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 806 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-older-source` Both early-October messages reach the Provider. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `O-empty-deadline` Response-time contract for the first question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-older-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-earliest-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=3322.012125000001 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=4470.187542 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `empty`: read state `empty`, payload told the model `completed`
  - `late-a:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `complete`, payload told the model `completed`
  - `early-a:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-02 (expected 2026-10-02)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `early-b:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-04 (expected 2026-10-04)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `earliest`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我看了下你存在那天的记录，二十三号那天没有找到你留下的话，能看到的范围里是空的。不过这也说明不了什么，没记录不等于你那天没说过或没发生过什么。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月一号和三号那两天你没有留下话，能查到的有十月二号和十月四号，都是晚上，各两条。二号晚上说的是你从救助站领回一只三个月大的橘猫，路上它在包里叫得很厉害，到家反倒一声不吭了，后来你又说它躲在沙发底下两天没露面，但碗里的粮每天早上都空着，看来是半夜出来偷吃。四号晚上说的是你周四下班带它去打了第二针疫苗，医生顺便看了耳朵，说是有点耳螨，开了一小瓶滴耳液，接着又讲到周六下午第一次给它滴耳药，按不住，手背被挠了一道，药倒是滴进去了。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "从我这边能查到的往回看，最早是十月二号晚上，你说从救助站领回一只三个月大的橘猫。再往前到七月二十七号这段范围里，没有更早提到猫的话了。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
- `earliest`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 36 ms | 2558 ms | 3541 ms | 3541 ms | 0 ms |
| `older` | warm | 24 ms | 3322 ms | 4470 ms | 4470 ms | 0 ms |
| `earliest` | warm | 32 ms | 917 ms | 1309 ms | 1309 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input 10602, output 228
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8188448, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
