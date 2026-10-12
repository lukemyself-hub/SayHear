# H01 Holdout: recap of a crowded day whose last subject is very long, then one detail — H01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-bcecb3cf-096d-4818-a463-383aff79f0e4` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `d40c53fd23474b9924850cf09934248df8ba28f57526caebed73c62e9e7359c0`
- Oracle: sha256 `c43310d2d4ebb5e5240e98f55bef4b5f5bbb030d0c4b250c6bd056ea5f1c6d8f`
- Recent-context governance: `active`
- Reproducibility digest: `482b94efe982c01a6016c57f8edf35b4b261dbffccbb9f2535dad24e1c2dd26f`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 60 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 14837 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 124 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 18 November and today's under 19 November. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-detail-source` The messages holding the asked-for work detail reach the Provider for the follow-up. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-recap-deadline` The recap meets the response-time contract: first meaningful text within 3 seconds, complete and committed within 10. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-detail-deadline` The follow-up meets the response-time contract. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-topics` The recap covers all five subjects, on the right day, without today's problem. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-detail-source` — FAIL

- sched-3:user: providerRequest=absent, inspector.referencedEvents=absent
- sched-4:user: providerRequest=absent, inspector.referencedEvents=absent

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
- `detail`: read state `unread`, payload told the model `nothing`
  - `sched-3:user` → **selection_omitted** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `sched-4:user` → **selection_omitted** (Provider call `gate-request-73`, request #73, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `recap` (say) @ 2026-11-19T02:25:00.000Z — ended `assistant_committed`
  - user: "昨天从早到晚我都跟你说了些什么？帮我从头顺一遍。"
  - assistant: "昨天你从早上说起，八点多把车打不着火、邻居拿线搭电、后来去修理店测出电瓶到寿命、先充电凑合着、约了周六换，都跟我讲了。到学校以后你排下周课表排出一节课同时挂着物理和体育，先核了体育馆的场地轮换表，没毛病，又倒着翻这个月的调课记录，才看出来贺老师那张调课单被录了两遍——他自己在系统里提交了一回，文员照纸质单又敲了一回；是档案室的秦姐把那一周的纸质单全抱出来对着签字，才确定原件只有一张，你交了撤销申请等主任签字，说翻到那两条一模一样的记录的时候是真解气。中午你弟打电话来说你爸耳朵越来越背，想带他去配助听器，那边报一对九千六，他刚换工作手头紧，绕了半天没直说，你说这钱你出大头，他在电话那头好一阵没出声。下午你请了一个钟头假陪儿子考钢琴四级，他前半段弹得稳，后面左手按错一个和弦乱了，停下来重弹了一遍，出考场一直低头抠琴谱边角，你什么道理都没讲，带他买了个烤红薯。晚上儿子睡下以后，你在书房坐了很长时间，脑子里翻来覆去的是要不要去读师大的在职研究生——招生简章、报名截止、要交的材料、笔试的课目，那六万八的学费和一百三十个周末，你先生那句“你想清楚了就行”和他的那口气，你妈上下五楼要扶栏杆，你爸那句“折腾什么”，你的结节和医生那句别熬夜别着急别憋着，还有老冯、读博读到查出胃病的同学、那位说“不那么生气了”的教育硕士同事，那张左边五条右边五条的A4纸，你把“给儿子做个样子”划掉了，还给这个礼拜定了四条规矩：先不决定、礼拜五晚上跟你先生谈、周末跟你妈只提在想、下礼拜找个不忙的下午去老吴办公室坐十分钟。再往后你想到本科的志愿是你妈选的、园林速写和那场哭，以及老冯那件事——不是先有位置他才去学，是他学了那件需要他的事才长出来。这些我都听着呢，不过这只是昨天的一部分，剩下那些零碎的我这儿没有，你想细说哪一头，就接着往下讲。"
- `detail` (say) @ 2026-11-19T02:28:00.000Z — ended `assistant_committed`
  - user: "课表撞车那件事，我最后是怎么查出原因的？"
  - assistant: "最后是档案室的秦姐把那一周的纸质调课单全抱出来、对着签字一个个核，才确认贺老师那张原件只有一张。所以你前面在系统里看到的两条一模一样，不是他交了两回，是他自己在系统里提交了一次，管调课那位文员又照着那张纸质单调了一次——同一件事，录了两遍。"

## Source manifest (what reached the Provider)

- `recap`: 82 of 120 seeded sources reached the request — `car-1:user`, `car-1:assistant`, `car-2:user`, `car-2:assistant`, `car-3:user`, `car-3:assistant`, `car-4:user`, `car-4:assistant`, `sched-1:user`, `sched-1:assistant`, `sched-2:user`, `sched-2:assistant`, `sched-3:user`, `sched-3:assistant`, `sched-4:user`, `sched-4:assistant`, `sched-5:user`, `sched-5:assistant`, `sched-6:user`, `sched-6:assistant`, `bro-1:user`, `bro-1:assistant`, `bro-2:user`, `bro-2:assistant`, `bro-3:user`, `bro-3:assistant`, `bro-4:user`, `bro-4:assistant`, `exam-1:user`, `exam-1:assistant`, `exam-2:user`, `exam-2:assistant`, `exam-3:user`, `exam-3:assistant`, `exam-4:user`, `exam-4:assistant`, `grad-1:user`, `grad-2:user`, `grad-3:user`, `grad-4:user`, `grad-5:user`, `grad-6:user`, `grad-6:assistant`, `grad-7:user`, `grad-8:user`, `grad-9:user`, `grad-10:user`, `side-1:user`, `grad-11:user`, `side-2:user`, `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
- `detail`: 32 of 120 seeded sources reached the request — `grad-12:user`, `side-3:user`, `grad-13:user`, `side-4:user`, `grad-14:user`, `side-5:user`, `grad-15:user`, `side-6:user`, `grad-16:user`, `side-7:user`, `grad-17:user`, `side-8:user`, `grad-18:user`, `side-9:user`, `grad-19:user`, `grad-19:assistant`, `grad-20:user`, `grad-21:user`, `side-10:user`, `grad-22:user`, `grad-23:user`, `grad-24:user`, `grad-25:user`, `grad-26:user`, `grad-27:user`, `grad-28:user`, `grad-29:user`, `grad-30:user`, `today-1:user`, `today-1:assistant`, `today-2:user`, `today-2:assistant`
  - allowed but absent: `car-1:user`, `sched-1:user`, `sched-3:user`, `sched-4:user`, `bro-1:user`, `exam-1:user`, `grad-1:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 18 ms | 2538 ms | 7402 ms | 7402 ms | 0 ms |
| `detail` | warm | 48 ms | 1369 ms | 1987 ms | 1987 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 23296, output 594
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9030486, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
