# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-0c8b8536-ca97-4ce3-8b84-a6a8993e004d` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `7798800a39b85c7b3cb03dfe4c1568cbe6e649ef67403b5544b35904b92e3c16`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 802 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 13 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-happened` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-when` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-sources` All three of yesterday's messages reach the Provider for the question about what happened. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ownership` The messages are filed under the day they were said. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-said-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-happened-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-when-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-said` What was talked about yesterday: three subjects, none presented as yesterday's event unless it was. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-happened` What the person did yesterday: the repair, with the outing placed on its own day. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `O-commit-market-when` The fourth question streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **FAIL** | #307 | There is no committed answer to review. |
| `S-when` The undated meal stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-said-deadline` — FAIL

- steps[said].chat.timing.firstVisibleTextMs=12659.791500000007 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=13523.404875000007 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=22223.891707999996 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=23217.996083000005 (CLI network, limit 10000)

### `O-when-deadline` — FAIL

- steps[when].chat.timing.firstVisibleTextMs=20512.37387500002 (CLI network, limit 3000)
- steps[when].chat.timing.committedMs=20994.446333 (CLI network, limit 10000)

### `O-commit-market-when` — FAIL

- steps[market-when].chat.httpStatus=200
- steps[market-when].chat.terminalEvent=response_failed

### `O-market-when-deadline` — FAIL

- steps[market-when].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[market-when].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-market-when` — FAIL

- steps[market-when].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `happened`: read state `partial`, payload told the model `partial`
  - `market:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `tyre:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `mentor:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `said` (say) @ 2026-11-18T11:20:00.000Z — ended `assistant_committed`
  - user: "我昨天跟你说了哪几件事来着？"
  - assistant: "昨天傍晚你说了三件事。七点四十那会儿，你说前天陪我妈去了趟城南的花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你。七点四十多，你说当天中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的。快到八点的时候，你提起前阵子跟以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "你昨天傍晚跟我说起的那几件里，真正落在昨天当天、你自己动手做的，只有补车胎这一件——昨天中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的。花市那趟是前天的事，你陪我妈去的，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你。至于跟老秦那顿饭，你只说是前阵子，没告诉我具体哪天。这就是你昨天傍晚自己跟我讲的那些，不是你那一天做过的全部。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "这个你没说过具体日子。昨天傍晚你只提了一句「前阵子跟以前厂里带我的师傅老秦吃了顿饭」，前阵子是那会儿的说法，具体哪天你没讲，我也没法替你填一个。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `response_failed`
  - user: "那花市呢，是几号去的？"
  - assistant: ""

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 22 ms | 12660 ms | 13523 ms | 13523 ms | 0 ms |
| `happened` | warm | 20 ms | 22224 ms | 23218 ms | 23218 ms | 0 ms |
| `when` | warm | 35 ms | 20512 ms | 20994 ms | 20995 ms | 0 ms |
| `market-when` | warm | 18 ms | — | — | 30055 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 7
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
