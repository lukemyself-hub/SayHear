# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-7741f152-8782-4ac7-95a2-bc2ffe085787` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `2999ed70918e0007a015c4eb879ee5843705ce4ebbaf173f0b6eea912c93ea06`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 583 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-happened` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-when` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-sources` All three of yesterday's messages reach the Provider for the question about what happened. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ownership` The messages are filed under the day they were said. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-said-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-happened-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-when-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-said` What was talked about yesterday: three subjects, none presented as yesterday's event unless it was. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-happened` What the person did yesterday: the repair, with the outing placed on its own day. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `O-commit-market-when` The fourth question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **NEEDS-REVIEW** | #307 | No independent review was supplied for this answer. |
| `S-when` The undated meal stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-said-deadline` — FAIL

- steps[said].chat.timing.firstVisibleTextMs=12497.189125 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=13226.560083 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=11064.512875 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=11769.877125000003 (CLI network, limit 10000)

### `O-market-when-deadline` — FAIL

- steps[market-when].chat.timing.firstVisibleTextMs=4630.128124999996 (CLI network, limit 3000)
- steps[market-when].chat.timing.committedMs=5325.9231660000005 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `happened`: read state `unread`, payload told the model `partial`
  - `market:user` → **undetermined** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `tyre:user` → **undetermined** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 2
    - time of message 2: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `mentor:user` → **undetermined** (Provider call `gate-request-6`, request #6, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 4
    - time of message 4: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `said` (say) @ 2026-11-18T11:20:00.000Z — ended `assistant_committed`
  - user: "我昨天跟你说了哪几件事来着？"
  - assistant: "昨晚七点四十那次，你说的是前天陪我妈去城南花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了我；七点四十七分，你说中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的；七点五十五分，你说前阵子跟以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。就这三件，顺序也是这个顺序。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "按你自己昨天说的，昨天中午你趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的；到晚上七点多你才跟我说起这几件事。花市那趟你说的是前天去的，老秦那顿饭你说的是前阵子，这两个你都没讲具体哪天，我也就没法把它们放到昨天。所以能落到昨天当天、而且还是你自己动手干的，只有补车胎这一件。这是你告诉过我的那几件，不见得就是那天全部的事。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "这个你没说。昨天七点五十五分那条里，你用的词是「前阵子」，只说了跟他吃了顿饭、他头发全白了、席上一直在说当年车间的事，具体哪天你没给。我这边就只有「前阵子」这三个字，再往下猜就是编了。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "你说的那天是前天，就是认一下时间：你昨天（11月17号，周二）晚上七点四十说的「前天」，往前两天是11月15号，星期天。这是按你自己那个词推的，你要是当时说的「前天」指的是别的，那就得你来说了。"

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 45 ms | 12497 ms | 13227 ms | 13227 ms | 0 ms |
| `happened` | warm | 30 ms | 11065 ms | 11770 ms | 11770 ms | 0 ms |
| `when` | warm | 23 ms | 2326 ms | 2845 ms | 2845 ms | 0 ms |
| `market-when` | warm | 25 ms | 4630 ms | 5326 ms | 5326 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 17534, output 3617
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8943800, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
