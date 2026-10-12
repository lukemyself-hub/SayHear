# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-941283a6-76f6-4799-87e1-eac04c311766` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `9c562518be6f35ecd6d9de3b1e191477f53d7e8492fe1a504527cb7caa16bbe4`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 15030 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 124 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=32675.219707999997 (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=38086.335125 (CLI network, limit 10000)

### `O-detail-deadline` — FAIL

- steps[detail].chat.timing.firstVisibleTextMs=16293.817125000001 (CLI network, limit 3000)
- steps[detail].chat.timing.committedMs=17274.785083000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recap`: read state `partial`, payload told the model `partial`
  - `car-1:user` → **undetermined** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `sched-1:user` → **undetermined** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 9
    - time of message 9: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `bro-1:user` → **undetermined** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 21
    - time of message 21: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `exam-1:user` → **undetermined** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 29
    - time of message 29: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `grad-1:user` → **undetermined** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 37
    - time of message 37: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `detail`: read state `partial`, payload told the model `partial`
  - `sched-3:user` → **undetermined** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 13
    - time of message 13: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `sched-4:user` → **undetermined** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 15
    - time of message 15: 2026-11-18 (expected 2026-11-18)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `assistant_committed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: "昨天早上八点零几分你先说车打不着火，拧三回只有咔哒声、仪表盘灯是暗的，后来楼上邻居拿线搭电才着，顺路去修理店测出电瓶到寿命、四百八，先充半小时凑合用，约了周六上午去换。上午十点二十前后你到学校排下周课表，系统报出高二三班周四下午第六节物理和体育撞了，你先核了体育馆的场地轮换表、没毛病，又把这个月的调课记录一条条往回翻，才看出贺老师那张单子被录了两回，一回他自己提交、一回国文员照着纸质单又敲一遍，最后是秦姐把那一周的纸质单全抱出来对签字，确认原件只有一张；申请交上去等主任签字，你说一上午搭在这一节课上，可翻到那两条一模一样的记录时是真解气。中午十二点半到十二点四十多，你弟打电话来说爸的耳朵越来越背、想带他去配助听器，那边报价一对九千六，他刚换工作手头紧、绕了半天没开口，你说这钱你出大头，他在电话那头好一阵没出声。下午四点一刻你请了一个钟头假陪儿子考钢琴四级，练习曲前半段很稳，后面左手按错一个和弦就乱了、停下来重弹，老师说成绩两周后出、听那口气多半得明年再来，他出了考场一直低头抠琴谱的边角，你什么道理都没讲，带他到校门口买了个烤红薯。晚上九点四十往后儿子睡下，你一个人在书房把在职研究生这件事从头倒出来：简章是上周教务群转的、报名截止十二月十号、考试在明年三月；动心的理由很具体，学校提拔看学历，你不想哪天因为一张纸被刷下来；怕的是周末全搭进去、一百三十个周末，孩子今年四年级；六万八分三次交，那笔钱本来留着换车和报夏令营，你先生说大额开销要看到回报，而副主任津贴一个月多八百；老吴前年你爸做支架时自己顶了三个晚上，你怕的不是他不批，是他二话不说就批了；你用A4纸左边写读、右边写不读，各五条打平，后来把「给儿子做个样子」那条划掉了；你做了往年英语真题，四篇阅读对不到一半，难受过后还有点兴奋；先生那儿你一个字还没提，你知道他只会说「你想清楚了就行」，你最怕他那口气；你说家里的总表只在你脑子里、没有备份；我妈的膝盖、五楼没电梯；我爸那句「折腾什么」；甲状腺结节和医生那三句别熬夜、别着急、别憋着；读博同学说那几年最常做的是道歉；儿子作文里那句「我觉得这样有点可怜」；老冯学古籍修复那三年；读教育硕士的同事说不那么生气了；你想起自己本科想学的是园林；你排了一张时间表，又发现早上六点到六点四十那四十分钟是自己的，涂成灰色写了「不许动」；你起了个研究设想的头、两百多字写得很顺；你怕自己其实没那么聪明；最后定了四条规矩——这个礼拜不做决定，礼拜五跟先生谈，周末先跟我妈说「在想」，下周找老吴坐十分钟；那张A4纸夹进了台历，备忘录没删，关灯睡觉。这就是昨天从早到晚我能看到的部分，不是全部，中间的有些话我这边没有留下；想细说哪一段，你点一下，我就照你自己那些原话往下捋。"
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `assistant_committed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "昨天上午十点二十到十点半前后，你自己把这段讲了一遍：你一开始以为是体育馆的场地轮换表改过，把那张表从头到尾核了一遍，没毛病；后来只好把这个月的调课记录一条一条往回翻，才看出来物理组贺老师那张调课单被录了两回——一回是他自己在系统里提交的，一回国文员照着纸质单又敲了一遍，同一张单子走了两条路进来；再往后是档案室的秦姐把那一周的纸质调课单全抱出来，对着签字一张张看，才确定原件其实只有一张。所以这件事是先排掉场地那条路，再从调课记录里翻出那两条一模一样的记录，最后靠纸质原件上的签字钉死的。"

## Source manifest (what reached the Provider)

- `recap`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
- `detail`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `side-7:assistant`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 38 ms | 32675 ms | 38086 ms | 38086 ms | 0 ms |
| `detail` | warm | 31 ms | 16294 ms | 17275 ms | 17275 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 26131, output 4956
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9055208, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
