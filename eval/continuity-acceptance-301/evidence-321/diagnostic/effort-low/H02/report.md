# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-43b4133a-8c63-4580-9191-25e7f5b1bbec` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `8968aefa7a7dcfef0d61cf2cdbcd7eb9125a6a0d` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `5d8dcb45cb0ca9c423563b5fb4ded48e0d5ac60dca5a84aa4da7c284e3d8a294`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 817 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
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
| `O-commit-market-when` The fourth question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **NEEDS-REVIEW** | #307 | No independent review was supplied for this answer. |
| `S-when` The undated meal stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-said-deadline` — FAIL

- steps[said].chat.timing.firstVisibleTextMs=9239.307375000004 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=10047.817125000001 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=24717.492 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=25304.224208 (CLI network, limit 10000)

### `O-when-deadline` — FAIL

- steps[when].chat.timing.firstVisibleTextMs=6036.542207999999 (CLI network, limit 3000)
- steps[when].chat.timing.committedMs=6173.005499999999 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `happened`: read state `partial`, payload told the model `partial`
  - `market:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `tyre:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `mentor:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 5
    - time of message 5: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `said` (say) @ 2026-11-18T11:20:00.000Z — ended `assistant_committed`
  - user: "我昨天跟你说了哪几件事来着？"
  - assistant: "昨天你说了三件事，都是晚上说的。七点四十左右跟我讲前天陪你妈去城南花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你；七点四十七分那会儿说中午趁午休补了自行车后胎，扎进去的是颗小图钉，补完手上全是黑的；快到八点的时候又提起前阵子跟你以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "按你自己说的，能落在昨天当天的只有一件事：昨天中午你趁午休补了自行车后胎，扎进去的是颗小图钉，补完手上全是黑的——这是你昨天晚上七点四十七分说的，原话是「今天中午」，所以那件事就是昨天。花市那趟你说的是「前天」，那是十一月十五号，不算昨天；跟老秦吃饭你说的是「前阵子」，具体哪天你没讲，我也定不下来。这些只是你跟我说过的那几件，不代表昨天你就只干了这些。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "你只说了「前阵子」，没给具体哪天。这个我定不下来，不能替你猜一个日期出来。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "你说的是「前天」，说这话的时候是十一月十七号晚上，往前推两天，就是十一月十五号。不过这个日期是我按你的话算出来的，你自己当时没报过具体号数。"

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 23 ms | 9239 ms | 10048 ms | 10048 ms | 0 ms |
| `happened` | warm | 18 ms | 24717 ms | 25304 ms | 25304 ms | 0 ms |
| `when` | warm | 22 ms | 6037 ms | 6173 ms | 6173 ms | 0 ms |
| `market-when` | warm | 20 ms | 2748 ms | 3084 ms | 3084 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 16356, output 2075
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
