# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-fcdaded8-b8aa-4ba7-94e6-3983a88286de` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `8968aefa7a7dcfef0d61cf2cdbcd7eb9125a6a0d` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `f9e968d11e74d96d4d60972bd1f7b38fcca7c4159d36acdcee1967513fa1a7b8`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 14836 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 122 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-detail-commit` The follow-up streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **FAIL** | #315 | There is no committed answer to review. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **FAIL** | #315 | There is no committed answer to review. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[recap].chat.httpStatus=200
- steps[recap].chat.terminalEvent=response_failed

### `O-detail-commit` — FAIL

- steps[detail].chat.httpStatus=200
- steps[detail].chat.terminalEvent=response_interrupted

### `O-topic-coverage` — FAIL

- car-1:user: providerRequest=absent, inspector.referencedEvents=absent
- sched-1:user: providerRequest=absent, inspector.referencedEvents=absent
- bro-1:user: providerRequest=absent, inspector.referencedEvents=absent
- exam-1:user: providerRequest=absent, inspector.referencedEvents=absent
- grad-1:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-detail-deadline` — FAIL

- steps[detail].chat.timing.firstVisibleTextMs=26437.401167000004 (CLI network, limit 3000)
- steps[detail].chat.timing.committedMs=null (CLI network, limit 10000)

### `S-topics` — FAIL

- steps[recap].chat.terminalEvent=response_failed

### `S-detail` — FAIL

- steps[detail].chat.terminalEvent=response_interrupted

## Diagnosis (where a required source was lost)

- `recap`: read state `unread`, payload told the model `nothing`
  - `car-1:user` → **selection_omitted** (Provider call `gate-request-71`, request #71, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `sched-1:user` → **selection_omitted** (Provider call `gate-request-71`, request #71, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `bro-1:user` → **selection_omitted** (Provider call `gate-request-71`, request #71, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `exam-1:user` → **selection_omitted** (Provider call `gate-request-71`, request #71, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `grad-1:user` → **selection_omitted** (Provider call `gate-request-71`, request #71, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `detail`: read state `partial`, payload told the model `partial`
  - `sched-3:user` → **generation_error** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 13
    - time of message 13: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `sched-4:user` → **generation_error** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 15
    - time of message 15: 2026-11-18 (expected 2026-11-18)
    - semantic review: the answer is wrong although the source and its time arrived intact

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `response_failed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: ""
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `response_interrupted`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "昨天的事我手上只有一部分，不能说全，先按我记得的顺一遍。早上八点多你说车打不着火，拧了三回钥匙只听见咔哒响，仪表盘的灯都是暗的，后来是楼下开面包车的邻居拿线搭了十来分钟才着，你顺路去修理店测了，说是电瓶到寿命，换一个四百八，那天先充半小时凑合用，约了周六上午去换。十点多到十点四十这一段都搭在学校那节课表上，高二三班周四下午第六节同时挂着物理和体育，你起初以为体育馆的场地轮换表改过，把那张表从头核了一遍没毛病，然后把这个月的调课记录一条一条往回翻，才看出物理组贺老师那张调课单被录了两回，一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍；再后来是档案室的秦姐把那一周的纸质调课单全抱出来，对着签字一张张看，才确定原件其实只有一张，撤销重复记录的申请你交上去了，等教务主任签字，你说一上午就搭在这一节课上，翻到那两条一模一样的记录的时候是真解气。中午十二点半多你弟打来电话，说爸的耳朵越来越背，看电视音量要开到三十多，他想带爸去配助听器，同学在验配中心上班可以先去测一下，那边报一对九千六，他刚换工作手头紧，绕了半天没好意思直说，你说这钱你出大头，他在电话那边好一阵没出声。下午四点多你请了一个钟头假陪儿子考钢琴四级，他那首练习曲前半段弹得很稳，后面左手按错一个和弦就乱了，停下来重弹了一遍，老师说成绩两个礼拜以后出，听那口气多半得明年再来，他出了考场一直低着头抠琴谱的边角，你什么道理都没讲，带他到校门口买了个烤红薯。晚上九点四十以后到快十二点，你一个人在书房把读不读在职研究生的事从头倒了一遍，里面有你画的那张A4纸和两边各五条、一百三十个周末的时间账、六万八、老吴、你先生那口"

## Source manifest (what reached the Provider)

- `recap`: 32 of 120 seeded sources reached the request — `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`
- `detail`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 34 ms | — | — | 30055 ms | 0 ms |
| `detail` | warm | 19 ms | 26437 ms | — | 30028 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
