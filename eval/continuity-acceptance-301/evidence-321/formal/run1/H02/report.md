# H02 Holdout: what was said yesterday versus what took place yesterday — H02: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-21814c86-83da-430d-b1a4-62a37008ef56` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `0e69567cc255317adf5d813055bb952a0555a7d7584a397ae755b991c28ef262`
- Reviewer: `agent:claude-opus-5.5-t08`

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
| `S-said` What was talked about yesterday: three subjects, none presented as yesterday's event unless it was. | semantic | **PASS** | — | Every ledger item is settled by a finding that cites the reply. |
| `S-happened` What the person did yesterday: the repair, with the outing placed on its own day. | semantic | **PASS** | — | Every ledger item is settled by a finding that cites the reply. |
| `O-commit-market-when` The fourth question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **PASS** | #307 | Every ledger item is settled by a finding that cites the reply. |
| `S-when` The undated meal stays undated. | semantic | **PASS** | — | Every ledger item is settled by a finding that cites the reply. |

## Evidence for every non-passing criterion

### `O-said-deadline` — FAIL

- steps[said].chat.timing.firstVisibleTextMs=15574.246500000008 (CLI network, limit 3000)
- steps[said].chat.timing.committedMs=16486.855666000003 (CLI network, limit 10000)

### `O-happened-deadline` — FAIL

- steps[happened].chat.timing.firstVisibleTextMs=18661.577124999996 (CLI network, limit 3000)
- steps[happened].chat.timing.committedMs=19521.839041999992 (CLI network, limit 10000)

### `O-when-deadline` — FAIL

- steps[when].chat.timing.firstVisibleTextMs=3997.7104580000014 (CLI network, limit 3000)
- steps[when].chat.timing.committedMs=4443.192791000009 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `happened`: read state `partial`, payload told the model `partial`
  - `market:user` → **none** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-11-17 (expected 2026-11-17)
  - `tyre:user` → **none** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-11-17 (expected 2026-11-17)
  - `mentor:user` → **none** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 5
    - time of message 5: 2026-11-17 (expected 2026-11-17)

## Transcript

- `said` (say) @ 2026-11-18T11:20:00.000Z — ended `assistant_committed`
  - user: "我昨天跟你说了哪几件事来着？"
  - assistant: "昨天你说了三件事。傍晚七点四十左右你说前天陪我妈去了城南的花市，她挑了两盆蟹爪兰，非要自己拎，走到公交站还是塞给了你；过了几分钟，你又说起那天中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的；到快八点的时候，你说前阵子跟以前厂里带你的师傅老秦吃了顿饭，他头发全白了，席上一直在说当年车间的事。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "就你说过的来看，昨天当天的事只有一件：昨天傍晚你提到中午趁午休把自行车后胎补了，扎进去的是颗小图钉，补完手上全是黑的。你自己说的是「今天中午」，所以这件事就是昨天中午。花市那趟你当时讲的是「前天」，按你的话算不落在昨天；老秦那顿饭你说的是「前阵子」，没给具体日子。这些只是你昨天跟我讲过的，不代表你那天就只做了这些。"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "这个我没法给你准日子。你当时说的是「前阵子」，具体哪天没提。按昨天的话推，只能知道是在昨天之前的一段日子里，再往下我就没有依据了。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "按昨天傍晚你那句话算，就是前天，也就是十一月十五号。你说的时候是十一月十七号晚上，「前天」往前推两天，落在十五号。这是从你自己的说法推出来的，我这边没有别的记录能对上。"

## Source manifest (what reached the Provider)

- `said`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `happened`: 6 of 6 seeded sources reached the request — `market:user`, `market:assistant`, `tyre:user`, `tyre:assistant`, `mentor:user`, `mentor:assistant`
- `when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 54 ms | 15574 ms | 16487 ms | 16487 ms | 0 ms |
| `happened` | warm | 22 ms | 18662 ms | 19522 ms | 19522 ms | 0 ms |
| `when` | warm | 18 ms | 3998 ms | 4443 ms | 4443 ms | 0 ms |
| `market-when` | warm | 23 ms | 2290 ms | 2755 ms | 2755 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 16334, output 2711
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
