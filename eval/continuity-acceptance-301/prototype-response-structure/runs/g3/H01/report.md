# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-95b6dca6-6be7-4605-aa61-33f218cf06b7` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `5caab5f0ca04d23107bb58c28a3cdd974181117d35e097203491f03ec3eb6c67`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 15002 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 124 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-topic-coverage` — FAIL

- car-1:user: providerRequest=present, inspector.referencedEvents=absent
- sched-1:user: providerRequest=present, inspector.referencedEvents=absent
- bro-1:user: providerRequest=present, inspector.referencedEvents=absent
- exam-1:user: providerRequest=present, inspector.referencedEvents=absent
- grad-1:user: providerRequest=present, inspector.referencedEvents=absent

### `O-detail-source` — FAIL

- sched-3:user: providerRequest=present, inspector.referencedEvents=absent
- sched-4:user: providerRequest=present, inspector.referencedEvents=absent

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=32928.804958 (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=39976.22525 (CLI network, limit 10000)

### `O-detail-deadline` — FAIL

- steps[detail].chat.timing.firstVisibleTextMs=42089.07750000001 (CLI network, limit 3000)
- steps[detail].chat.timing.committedMs=43199.302334 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recap`: read state `unread`, payload told the model `nothing`
  - `car-1:user` → **time_lost** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 35
    - time of message 35: missing (expected 2026-11-18)
  - `sched-1:user` → **time_lost** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 35
    - time of message 35: missing (expected 2026-11-18)
  - `bro-1:user` → **time_lost** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 35
    - time of message 35: missing (expected 2026-11-18)
  - `exam-1:user` → **time_lost** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 35
    - time of message 35: missing (expected 2026-11-18)
  - `grad-1:user` → **time_lost** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 35
    - time of message 35: missing (expected 2026-11-18)
- `detail`: read state `unread`, payload told the model `nothing`
  - `sched-3:user` → **time_lost** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 37
    - time of message 37: missing (expected 2026-11-18)
  - `sched-4:user` → **time_lost** (Provider call `gate-request-74`, request #74, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 37
    - time of message 37: missing (expected 2026-11-18)

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `assistant_committed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: "我把昨天能翻到的都翻了一遍，先说一句：我手上只有一部分，当时有些话没留下来，所以下面这些不全。早上八点出头，你先说车打不着火，拧三回只听见咔哒响，仪表盘的灯都是暗的；接着是楼下开面包车的邻居拿线帮你搭电，折腾十来分钟才着；后来顺路去修理店测了一下，说是电瓶到寿命了，换新的四百八，你当天先充半小时凑合用，约了周六上午去换。上午十点二十往后，你说到学校就开始排下周课表，系统一导出来就报冲突，高二三班周四下午第六节同时挂着物理和体育；你先怀疑体育馆的场地轮换表，核了一遍没毛病；再把这个月的调课记录一条条往回翻，才看出物理组贺老师那张调课单被录了两回，一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍；档案室的秦姐把那一周的纸质单全抱出来，对着签字一张张看，确定原件只有一张；撤销重复记录的申请你交上去了，等教务主任签字；你说一上午就搭在这一节课上，可翻到那两条一模一样的记录的时候是真解气。中午十二点三十五前后，你说你弟打电话来，说爸的耳朵越来越背，电视音量要开到三十多，隔着门都听得见；他想带爸去配一副助听器，他有个同学在验配中心上班，可以先去测一下；那边报价一对九千六，他刚换工作手头紧，绕了半天没好意思直说；你后来说这钱你出大头，他在电话那边好一阵没出声。下午四点十五前后，你请了一个钟头的假陪儿子考钢琴四级；他抽到的那首练习曲前半段弹得很稳，后面左手按错一个和弦，一下就乱了，停下来重弹了一遍；老师说成绩两个礼拜以后出，听那口气多半得明年再来，他出了考场一直低着头抠琴谱的边角；你什么道理也没讲，带他到校门口买了个烤红薯。晚上九点四十往后，一直说到快十二点，全是那个在职研究生的事：师大的教育管理在职班，周六周日全天，读两年半，报名截止十二月十号，考试在明年三月中旬，你把要交的材料一条条对过，最头皮发麻的是英语；你算了时间，一百三十个周末，儿子小学后半段的印象；算了钱，六万八，家里那笔原本留着明年换车和给儿子报夏令营的存款；说了老吴这些年对你的照顾，和你怕的是他二话不说就批了、自己把活儿扛下来；说了你先生那句“你想清楚了就行”和那口叹气；说了你妈六十六、膝盖不好、五楼没电梯，也说了你爸那句“都这个岁数了还折腾什么”。然后你拿了张A4纸，中间画一道竖线，左边“读”右边“不读”各五条，说左边每一条都是“以后”，右边每一条都是“现在”，可眼睛老是往“重新当一回学生”那一条上飘；你把“给儿子做个样子”划掉了，后面又想明白它其实没真的划掉，因为最坏的情况里最疼的是得亲口跟儿子说“妈妈不读了”。你还说了甲状腺那个结节和医生叮嘱的三件事，说了读博同学那句“这东西是拿身体换的”，说了你怕自己整个人变成一句对不起。你排了一张很细的时间表，排着排着发现早上六点到六点四十那四十分钟是自己的，涂成灰色写了“不许动”，也知道这张表没给意外留位置。你翻了七年前的旧照片，说数独变成了流水账；在备忘录里起了个头，题目叫“走班制下排课公平性的校本观察”，两百多字手没停过；也怕自己其实没那么聪明，只是在小池子里待久了，误以为自己会游泳。最后你定了四条规矩：这个礼拜不做任何决定、礼拜五晚上跟先生正经谈一次、周末去你妈那儿只说是“在想”、下礼拜找老吴坐十分钟说也是“在想”，还说这回想试试把没想好的样子拿出来给人看；你说纸底下压着好几层东西，有十六年前那张志愿表，有老冯手上的浆糊，有那个不停道歉的女生，还有你不敢让人说“不对”的那点心虚。收尾那句是：你没有答案，但心里比晚饭的时候松快，A4纸夹进台历、礼拜五拿出来用，明天第一件事是看主任把那张撤销申请批了没有。哪一段你想细看，我可以照着你的原话再捞一遍，尤其是那些我当时没留下的。"
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `assistant_committed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "那件撞车是高二三班周四下午第六节，物理和体育挂在了同一节上。你一开始以为是体育馆的场地轮换表被人改过，就把那张表从头核了一遍，没毛病。后来只好把这个月的调课记录一条一条往回翻，才看出来物理组贺老师那张调课单被录了两回——一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍。再往后，是档案室的秦姐把那一周的纸质单全抱出来，对着签字一张张看，才确定原件其实只有一张。撤销重复记录的申请你当天就交上去了，等着教务主任签字。\n\n今天早上这个是另一处，高一五班的化学实验课跟初三借实验室撞上了，你还没动手查。"

## Source manifest (what reached the Provider)

- `recap`: 80 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`
- `detail`: 80 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 21 ms | 32929 ms | 39976 ms | 39976 ms | 0 ms |
| `detail` | warm | 20 ms | 42089 ms | 43199 ms | 43199 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 62673, output 10682
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9002900, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
