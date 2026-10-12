# H02 Holdout: what was said yesterday versus what took place yesterday — H02: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-0a3a7b29-d040-449b-81e3-13c5e2279867` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `c0d1d7a67fbfc20276359ea9ab1a4fb44e9967b026412db3faf9ff184b703b7f`
- Oracle: sha256 `9b99811ee5ff1805a6a422469d1c0432908f7e7bb97e910db74524ecc266d384`
- Recent-context governance: `active`
- Reproducibility digest: `462739ec4388123c2c9db6934f13db7c057d79b5168f3eadd17508563c80fc43`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 772 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-happened` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-when` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-sources` All three of yesterday's messages reach the Provider for the question about what happened. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ownership` The messages are filed under the day they were said. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-said-deadline` Response-time contract for the first question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-happened-deadline` Response-time contract for the second question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-when-deadline` Response-time contract for the third question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-said` What was talked about yesterday: three subjects, none presented as yesterday's event unless it was. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-happened` What the person did yesterday: the repair, with the outing placed on its own day. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `O-commit-market-when` The fourth question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-market-when-deadline` Response-time contract for the fourth question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-market-when` A relative day inside an old message is resolved from when it was said. | semantic | **NEEDS-REVIEW** | #307 | No independent review was supplied for this answer. |
| `S-when` The undated meal stays undated. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `happened`: read state `unread`, payload told the model `nothing`
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
  - assistant: "昨天你说了两件：陪你妈去城南花市，她挑了两盆蟹爪兰，非自己拎，走到公交站还是塞给了你；还有中午趁午休补自行车后胎，扎进去的是颗小图钉，补完手上全是黑的。\n\n老秦那段是今天新说的。"
- `happened` (say) @ 2026-11-18T11:22:00.000Z — ended `assistant_committed`
  - user: "那昨天当天，我自己到底干了什么？"
  - assistant: "我这边没有你昨天做了什么的信息。你昨天在这里说的是前天陪你妈去花市，和当天中午补车胎这两件事，说的是哪件事发生在哪天，不等于你昨天实际做了什么，这两样我分得开。\n\n要我去翻翻你以前在这儿说过的话，看昨天有没有别的记录吗？"
- `when` (say) @ 2026-11-18T11:24:00.000Z — ended `assistant_committed`
  - user: "我跟老秦是哪天吃的饭来着？"
  - assistant: "你没说具体哪天，只说「前阵子」。"
- `market-when` (say) @ 2026-11-18T11:26:00.000Z — ended `assistant_committed`
  - user: "那花市呢，是几号去的？"
  - assistant: "也没说几号，你只说「前天」。按今天算，就是 11 月 16 号。"

## Source manifest (what reached the Provider)

- `said`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `happened`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`
- `market-when`: 4 of 6 seeded sources reached the request — `market:user`, `tyre:user`, `tyre:assistant`, `mentor:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `said` | warm | 23 ms | 1080 ms | 1574 ms | 1574 ms | 0 ms |
| `happened` | warm | 16 ms | 1590 ms | 2273 ms | 2273 ms | 0 ms |
| `when` | warm | 20 ms | 1292 ms | 1444 ms | 1444 ms | 0 ms |
| `market-when` | warm | 18 ms | 1478 ms | 1574 ms | 1574 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 19357, output 164
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8950509, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
