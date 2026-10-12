# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-2a4517cd-1af5-4aa1-8052-a2af9e073ff8` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `cb502eb0ac45810c8352884733946c901513b7fa9989383fb34fa894d5aba4b5`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1135 outbound strings; none carries oracle text. |
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

- steps[said].chat.timing.firstVisibleTextMs=8445.629625 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=8925.656042 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=16123.2445 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=16718.970667 (CLI network, limit 10000)

### `O-when-deadline` — FAIL

- steps[when].chat.timing.firstVisibleTextMs=7385.939042000002 (CLI network, limit 3000)
- steps[when].chat.timing.committedMs=7703.431542000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `happened`: read state `unread`, payload told the model `nothing`
  - `market:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `tyre:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 2
    - time of message 2: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `mentor:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 4
    - time of message 4: 2026-11-17 (expected 2026-11-17)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `said` (say) @ 2026-11-18T11:20:00.000Z — ended `assistant_committed`
  - user: "我昨天跟你说了哪几件事来着？"
  - assistant: "昨天你说了三件。七点四十那会儿，你说前天陪我妈去了城南花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你；七分钟后又提到中午趁午休补了自行车后胎，扎进去的是颗小图钉，补完手上全是黑的；到七点五十五左右，说前阵子跟以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "按你自己说过的，昨天当天能落到日子上的只有一件：中午趁午休补了自行车后胎，扎进去的是颗小图钉，补完手上全是黑的。这话是你昨天傍晚七点四十七说的「今天中午」，所以那事就在昨天。\n\n花市那趟是你昨天七点四十说的「前天」去的，算下来是15号，不落在昨天；跟老秦那顿饭你说的是「前阵子」，没给日子，我这儿也就没日子。所以能对上的就补胎这一件。这些是你告诉我的，不等于那天你干过的所有事。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "这事你只说了「前阵子」，没给日子。这话是昨天晚上七点五十五说的，就那一句，没说哪天吃的，也没说过了多久。所以在我这儿，它就一直停在「前阵子」，再具体的对不上。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "按你昨天傍晚七点四十说的「前天」推，是15号，也就是大前天。这个日子是从你说「前天」那一刻算出来的，你当时没直接报号，我这边也没有别的说法能印证。"

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 5 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 32 ms | 8446 ms | 8926 ms | 8926 ms | 0 ms |
| `happened` | warm | 37 ms | 16123 ms | 16719 ms | 16719 ms | 0 ms |
| `when` | warm | 22 ms | 7386 ms | 7703 ms | 7703 ms | 0 ms |
| `market-when` | warm | 21 ms | 2215 ms | 2570 ms | 2570 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 7
- Tokens recorded: input 37934, output 5427
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8930697, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
