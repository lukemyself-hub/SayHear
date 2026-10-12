# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-924fc740-b10a-4d8a-a104-916bbb0e42d4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `9d6023a8eca57c6a0db7b7aca0557a18b1e9927af9ee8ba4807d33c287824400`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 12975 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 124 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
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

- sched-3:user: providerRequest=absent, inspector.referencedEvents=absent
- sched-4:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-recap-deadline` — FAIL

- steps[recap].chat.timing.firstVisibleTextMs=18472.235375 (CLI network, limit 3000)
- steps[recap].chat.timing.committedMs=22893.341291999997 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recap`: read state `unread`, payload told the model `partial`
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
- `detail`: read state `unread`, payload told the model `nothing`
  - `sched-3:user` → **selection_omitted** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `sched-4:user` → **selection_omitted** (Provider call `gate-request-72`, request #72, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `assistant_committed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: "昨天一整天你说的事，我这儿存下的不是全部，先按时间给你顺一遍。早上八点零五你写车子打不着火，拧了三回钥匙只听见咔哒咔哒响，仪表盘的灯都是暗的；八点零八分说楼下开面包车的邻居拿线帮你搭了电，折腾十来分钟才着；八点十一分你顺路开去修理店测了一下，说电瓶到寿命了，换个新的四百八；八点十四分你说先充半小时凑合用，约了周六上午去换。十点二十开始是课表那件事，系统一导出就报高二三班周四下午第六节同时挂着物理和体育；十点二十四分你先排除了体育馆的场地轮换表，从头核了一遍没毛病；十点二十九分你一条一条往回翻调课记录，才看出物理组贺老师那张调课单被录了两回，一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍；十点三十三分档案室的秦姐把那一周的纸质调课单全抱出来对着签字看，才确定原件只有一张；十点三十七分你说撤销重复记录的申请已经交上去了，等教务主任签字；十点四十二分你说一上午就搭在这一节课上，可翻到那两条一模一样的记录的时候是真解气。中午十二点三十五分你弟打电话来，说爸的耳朵越来越背，电视音量要开到三十多；十二点三十八分说他想带爸去配一副助听器，他有个同学在验配中心上班；十二点四十一分那边报价一对九千六，你弟刚换工作手头紧，绕了半天没好意思直说；十二点四十四分你说这钱你出大头，他在电话那边好一阵没出声。下午四点一刻你请了一个钟头的假陪儿子考钢琴四级，说抽到的那首练习曲前半段弹得很稳，后面左手按错了一个和弦，停下来重弹了一遍；四点二十一分你说老师说成绩两个礼拜以后出，听那口气多半得明年再来，他出了考场一直低着头抠琴谱的边角；四点二十四分你什么道理也没讲，带他到校门口买了个烤红薯。晚上九点四十以后，你在书房把读不读那个在职研究生的事整个倒了出来：师大的教育管理在职班，周六周日全天上课，两年半，学费六万八分三次交，报名十二月十号截止，明年三月中考笔试；你说动心的理由很具体，学校这两年提拔中层都在看学历，去年竞聘教务副主任上去的就是唯一有硕士文凭的那个；发怵的是一百三十个周末，是家里那张只存在你脑子里的总表，是你先生那句「你想清楚了就行」和那声很轻的叹气，是你妈六十六岁的膝盖和五楼没电梯，是你爸那句「折腾什么」，是你自己的甲状腺结节和医生说的别熬夜、别着急、别憋着，还有你那个读博同学讲的「两边都觉得你占了便宜」和她那几年不停地道歉。你也说了不读的话五年后是什么样——心里是平的，像看一张别人的照片；说过儿子学游泳站在池边腿抖、跳下去以后眼睛亮得吓人；说过老冯那三年和那句「头一回觉得周末是自己的」；也说过在职读研真实的熬和凑，两个同事周一的脸是灰的、办公室里有过的哭、花钱在没听说过的刊物上发文章；说过食堂里那位读教育硕士的同事讲「不那么生气了」；说过儿子作文里那句「我觉得这样有点可怜」；你在A4纸左右各写了五条，后来把「给儿子做个样子」划掉，排来排去「重新当一回学生」还是第一；还有你问自己的那两个假设问题，旁听课那些便宜办法，健身卡、日语、水彩的三次前科，承认自己需要一根竹竿，早上六点到六点四十那四十分钟被你涂成灰色、旁边写了「不许动」，最坏的情况里最疼的是要亲口跟儿子说「妈妈不读了」，还有七年前那张站在贴满课表的墙前面、手里拿荧光笔的照片；你也起了研究设想的头，「走班制下排课公平性的校本观察」，两百多字手没停过，还有你说出来的那一长串怕。最后你定了四条规矩，这周不做决定、周五晚上跟先生谈、周末跟妈妈只说在想、下礼拜找老吴说在想，还说这回要把没想好的样子拿出来给人看；收尾说去还是不去没有答案，可心里比吃晚饭的时候松快，纸夹进了台历，备忘录那两百多字没删。这就是我手里有的昨天，缺的那些我没法替你补上，你想细说哪一件，我从你自己的原话往下捋。"
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `assistant_committed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "你是从两个方向夹出来的那一条记录。先把体育馆的场地轮换表从头核了一遍，排除了场地那边的问题；然后一条一条往回翻调课记录，才看出物理组贺老师那张调课单在系统里出现了两回——一回是他自己在系统里提交的，一回是文员照着纸质单又敲了一遍。为了确认，你让档案室的秦姐把那一周的纸质调课单全抱出来，对着签字一张张看，确定原件只有一张。原因清楚以后，撤销那条重复记录的申请就交上去了，等教务主任签字。"

## Source manifest (what reached the Provider)

- `recap`: 80 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`
- `detail`: 32 of 120 seeded sources reached the request — `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 20 ms | 18472 ms | 22893 ms | 22893 ms | 0 ms |
| `detail` | warm | 20 ms | 2135 ms | 2793 ms | 2793 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 29027, output 4264
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9019041, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
