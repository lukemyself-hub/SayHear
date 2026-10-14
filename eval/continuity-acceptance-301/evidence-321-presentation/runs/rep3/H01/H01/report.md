# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-70bba8ae-a9f4-4471-b2fc-e0eb276f963d` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `38366d3704f25332a079634bc5ff3df841cf7e9c8735dc4f576428050ee71b1a`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 14692 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 123 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **FAIL** | #315 | There is no committed answer to review. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[recap].chat.httpStatus=200
- steps[recap].chat.terminalEvent=response_failed

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-detail-deadline` — FAIL

- steps[detail].chat.timing.firstVisibleTextMs=19889.248667 (CLI network, limit 3000)
- steps[detail].chat.timing.committedMs=23810.746708 (CLI network, limit 10000)

### `S-topics` — FAIL

- steps[recap].chat.terminalEvent=response_failed

## Diagnosis (where a required source was lost)

- `recap`: read state `partial`, payload told the model `partial`
  - `car-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `sched-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 9
    - day of entry 9: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `bro-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 21
    - day of entry 21: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `exam-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 29
    - day of entry 29: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `grad-1:user` → **generation_error** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 37
    - day of entry 37: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
- `detail`: read state `partial`, payload told the model `partial`
  - `sched-3:user` → **undetermined** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 13
    - day of entry 13: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `sched-4:user` → **undetermined** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 15
    - day of entry 15: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `response_failed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: ""
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `assistant_committed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "昨天你跟我说的，我这儿只留着一部分，不是全的，我先按记得的顺一遍。早上八点多车打不着火，咔哒咔哒响，楼下开面包车的邻居拿线搭了电，后来顺路去修理店测，说是电瓶到寿命了，换新的四百八，那天先充了半小时凑着用，约了周六上午去换。上午十点二十到学校排下周课表，系统一导出来就报冲突：高二三班周四下午第六节同时挂着物理和体育；你先以为体育馆场地轮换表改过，从头核了一遍没毛病，只好把调课记录一条条往回翻，才看出物理组贺老师那张调课单被录了两回——一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍；档案室的秦姐把那一周的纸质调课单全抱出来对着签字看，确定原件只有一张；撤销重复记录的申请你交上去了，等教务主任签字。中午你弟打电话说爸耳朵越来越背，电视音量开到三十多，他想带爸去配助听器，他同学在验配中心，那边报价一对九千六，他刚换工作手头紧绕了半天没好意思直说，你说这钱你出大头。下午请了一个钟头假陪儿子考钢琴四级，抽到的练习曲前半段挺稳，后面左手按错一个和弦，停下来重弹了一遍，老师说成绩两个礼拜后出，听那口气多半得明年再来，他出了考场一直低着头抠琴谱边角，你没讲道理，带他到校门口买了个烤红薯。晚上儿子睡了以后你一个人在书房坐着，想的都是那个在职研究生：师大教育管理方向，周六周日全天上课，两年半，报名截止十二月十号；你今年三十九，本科毕业十六年，学费六万八分三次交；你拿了张A4纸画竖线，左边读右边不读各写了五条，数完打平；你还试了一套往年英语真题，阅读四篇做了一个小时，对的不到一半；你想到你先生那声叹气，想到你妈爬五楼，想到你爸那句“折腾什么”，想到老吴，想到自己的身体，想到那个读博同学，想到老冯；研究设想你在备忘录里起了个头，叫走班制下排课公平性的校本观察，写了两百多字；最后你给自己定了四条：这周不做任何决定，礼拜五晚上跟先生正经谈一次，周末去你妈那儿只说“在想”，下礼拜找个下午去老吴办公室坐十分钟。至于课表撞车那件，查出来的原因就是那张调课单被录了两回，一回是贺老师自己在系统里提交的，一回是文员照着纸质单又敲了一遍，所以同一张单子走了两条路进来，才在系统里撞上。我手上就这些，你要是想细说哪一件，我就着你自己说的话跟你往下捋。"

## Source manifest (what reached the Provider)

- `recap`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
- `detail`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 26 ms | — | — | 30054 ms | 0 ms |
| `detail` | warm | 22 ms | 19889 ms | 23811 ms | 23811 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7388949, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
