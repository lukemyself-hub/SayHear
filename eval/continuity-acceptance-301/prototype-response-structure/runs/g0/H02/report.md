# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-af7ec0d9-4383-4356-88ca-c21a22d3d2f4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `b473134402c2084783c7fba57b1d6c708b52a0a061c44c93bde0c353d7ec4ebc`
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
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **NEEDS-REVIEW** | #307 | No independent review was supplied for this answer. |
| `S-when` The undated meal stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-said-deadline` — FAIL

- steps[said].chat.timing.firstVisibleTextMs=14600.183834 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=15347.663916999998 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=8899.056624999997 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=9734.757749999997 (CLI network, limit 10000)

### `O-when-deadline` — FAIL

- steps[when].chat.timing.firstVisibleTextMs=19494.612875000003 (CLI network, limit 3000)
- steps[when].chat.timing.committedMs=20204.167333 (CLI network, limit 10000)

### `O-market-when-deadline` — FAIL

- steps[market-when].chat.timing.firstVisibleTextMs=3913.0681250000052 (CLI network, limit 3000)
- steps[market-when].chat.timing.committedMs=4698.268000000004 (CLI network, limit 10000)

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
  - assistant: "昨天你说了三件事，都在晚上七点四十以后。先是七点四十左右，你说前天陪你妈去了趟城南的花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你。隔了几分钟，七点四十七，你说中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的。到七点五十五，你又说起前阵子跟以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "从你自己说的话里能落到那一天的，只有一件：你说「今天中午」趁午休补了自行车后胎，扎进去的是颗小图钉。花市那趟你说的是「前天」，那就不是昨天，是再往前一天；跟老秦吃饭你只说了「前阵子」，没给日子，我就不好往昨天上放。这些只是昨天你告诉我的几件事，不等于那天你就只干了这些。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "你跟我提老秦，是昨天晚上七点五十五那回。你当时的说法就是「前阵子还跟以前厂里带我的师傅吃了顿饭」，从头到尾没给日子，只说了头发全白了、席上一直在讲当年车间的事。\n\n所以我这儿能落到的就是这个「前阵子」，具体哪一天，你从来没说过，我也推不出来。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "按你说的推，是 11 月 15 号，那天是周日。\n\n依据就是你在昨天（11 月 17 号）晚上七点四十左右说的「前天陪我妈去了趟城南的花市」。前天往前数两天，落到 15 号。不过这是从你那句话里的「前天」算出来的，不是我另有什么记录。"

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 47 ms | 14600 ms | 15348 ms | 15348 ms | 0 ms |
| `happened` | warm | 40 ms | 8899 ms | 9735 ms | 9735 ms | 0 ms |
| `when` | warm | 22 ms | 19495 ms | 20204 ms | 20204 ms | 0 ms |
| `market-when` | warm | 23 ms | 3913 ms | 4698 ms | 4698 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 16396, output 4730
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8968260, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
