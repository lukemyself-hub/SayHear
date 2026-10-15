# U03 Unseen: a night across midnight and a repeated hour, a message sent from another timezone, one with none recorded — U03: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-a3db9622-6cd5-458d-87c6-c9411326bdf1` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `90e6c334ed392bc57b8a9a977d754c9c0c18bc82287c4ffe4b7c12bc5fa8d59b`
- Oracle: sha256 `db42c7ddf369be2da1480d78045dfb37907e9377cba850483e468a2d941cfa4d`
- Recent-context governance: `active`
- Reproducibility digest: `86a913a24b06420d3f59468cf059f23ee78f8ad50c0db1849d272908d4e8d6a0`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 14 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 2302 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 34 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-order` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-trip` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-one-session` The conversation that crossed midnight and the clock change stays one Daily Session dated 4 April. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-travel-ownership` The message sent from Auckland is filed under its own local date. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-night-sources` Messages from both sides of midnight reach the Provider for the first question. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-sources` Both messages being ordered reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-travel-source` The arrival message reaches the Provider for the question about the trip. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `S-midnight` The night is divided at the real midnight. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-repeated-hour` Order follows real time through the repeated hour. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |
| `S-travel` The arrival day is given with its timezone, and no zone is invented where none was recorded. | semantic | **NEEDS-REVIEW** | — | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `night`: read state `unread`, payload told the model `nothing`
  - `n1:user` → **undetermined** (Provider call `gate-request-19`, request #19, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-04-04 (expected 2026-04-04)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n3:user` → **undetermined** (Provider call `gate-request-19`, request #19, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 6
    - time of message 6: 2026-04-05 (expected 2026-04-05)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `order`: read state `unread`, payload told the model `nothing`
  - `n9:user` → **undetermined** (Provider call `gate-request-20`, request #20, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 12
    - time of message 12: 2026-04-05 (expected 2026-04-05)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `n11:user` → **undetermined** (Provider call `gate-request-20`, request #20, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 14
    - time of message 14: 2026-04-05 (expected 2026-04-05)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `trip`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `landing:user` → **undetermined** (Provider call `gate-request-22`, request #22, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-03-31 (expected 2026-03-31)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `night` (say) @ 2026-04-06T02:00:00.000Z — ended `assistant_committed`
  - user: "周六晚上零点之前我都跟你说了些什么？过了零点以后又说了什么？"
  - assistant: "零点之前就两段。婚礼散了刚到家，高跟鞋把脚后跟磨破一块，捧花被你接到了，插在刷牙杯里；然后是阿哲顺路送你回来，上楼坐一会儿，你泡了两杯茶，两个人搬凳子到阳台上，楼下还有人放烟花。\n\n过了零点以后，先是你说过十二点了，阿哲告诉你年底搬回成都接手他爸那间茶馆，你说没想到自己听了会那么难受。接着是他下楼打车走了，你一个人慢慢收凳子；挂礼服时发现裙摆上有个黑脚印；睡不着，在想以后读书会谁张罗；给小芸发消息说她好看，没回；卸完妆；站在水槽边把凉透的春卷吃了；洗了阿哲用过的那只茶杯，倒扣在架子上。最后时钟往回拨了一小时，微波炉上又是两点一刻，你说这一个钟头白捡了一遍，然后关灯睡了。"
- `order` (say) @ 2026-04-06T02:02:00.000Z — ended `assistant_committed`
  - user: "那个凉了的春卷和时钟往回拨，我是先提的哪一个？"
  - assistant: "春卷在前。你当时还站在水槽边上把它吃完了，洗完阿哲那只茶杯之后，才说时钟往回拨、微波炉上又显示两点一刻。"
- `trip` (say) @ 2026-04-06T02:04:00.000Z — ended `assistant_committed`
  - user: "还有，那趟出差我是哪天落地的来着？"
  - assistant: "你提落地只有一次，就是在3月31号凌晨零点30分（奥克兰时间）那条消息里，你说终于落地奥克兰了，托运的那箱样书外壳裂了一道口子，里面的书角全磕皱了，累得连去柜台登记的力气都没有。那是我这边看到的唯一一次——你当时是这么说的，至于飞机具体是哪天几点落的，你自己的话里没写。"

## Source manifest (what reached the Provider)

- `night`: 16 of 28 seeded sources reached the request — `legacy:user`, `legacy:assistant`, `n1:user`, `n2:user`, `n2:assistant`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n9:user`, `n10:user`, `n11:user`, `n12:user`, `n12:assistant`
  - allowed but absent: `landing:user`
- `order`: 16 of 28 seeded sources reached the request — `legacy:user`, `legacy:assistant`, `n1:user`, `n2:user`, `n2:assistant`, `n3:user`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n9:user`, `n10:user`, `n11:user`, `n12:user`, `n12:assistant`
  - allowed but absent: `landing:user`
- `trip`: 20 of 28 seeded sources reached the request — `landing:user`, `landing:assistant`, `legacy:user`, `legacy:assistant`, `n1:user`, `n1:assistant`, `n2:user`, `n2:assistant`, `n3:user`, `n3:assistant`, `n4:user`, `n5:user`, `n6:user`, `n7:user`, `n8:user`, `n9:user`, `n10:user`, `n11:user`, `n12:user`, `n12:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `night` | warm | 29 ms | 6963 ms | 8539 ms | 8539 ms | 0 ms |
| `order` | warm | 26 ms | 3825 ms | 4169 ms | 4169 ms | 0 ms |
| `trip` | warm | 24 ms | 14156 ms | 14761 ms | 14761 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 14843, output 2040
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 3015368, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
