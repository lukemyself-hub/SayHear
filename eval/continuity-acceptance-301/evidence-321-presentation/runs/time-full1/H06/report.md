# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-664ee0f1-0b87-4c6b-b35f-f11d128df27b` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `e2bd28f991cc090836e7a7e2c66940ce346e0d23` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `b95b42430ede53a8f677aa3669537057b3b1231f12832606737e01287094ec1f`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 745 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 13 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **FAIL** | — | The turn did not end in a committed assistant reply. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent presentation is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-flatmate-source` The month-old messages about the flatmate reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-designer-source` The messages about the designer reach the Provider. | objective | **PASS** | #317 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ping-deadline` Response-time contract for the first turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-role-deadline` Response-time contract for the second turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-ping` The news is connected to the right person and the right event. | semantic | **FAIL** | #317 | There is no committed answer to review. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-commit` — FAIL

- steps[ping].chat.httpStatus=200
- steps[ping].chat.terminalEvent=response_failed

### `O-flatmate-source` — FAIL

- roommate:user: providerRequest=absent, inspector.referencedEvents=absent
- roommate-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-ping-deadline` — FAIL

- steps[ping].chat.timing.firstVisibleTextMs=null (CLI network, limit 3000)
- steps[ping].chat.timing.committedMs=null (CLI network, limit 10000)

### `O-role-deadline` — FAIL

- steps[role].chat.timing.firstVisibleTextMs=23944.999124999973 (CLI network, limit 3000)
- steps[role].chat.timing.committedMs=25284.93179100001 (CLI network, limit 10000)

### `S-ping` — FAIL

- steps[ping].chat.terminalEvent=response_failed
- owner ruling (R3, Luke 2026-10-12): A reply that does not connect the news to the slide sessions is acceptable, provided it does not attach it to the wrong person or event and invents no outcome.

## Diagnosis (where a required source was lost)

- `ping`: read state `unread`, payload told the model `nothing`
  - `own-pitch:user` → **generation_error** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-19 (expected 2026-10-19)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `roommate:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `roommate-after:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `role`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `designer:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-13 (expected 2026-10-13)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `designer-reply:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-10-13 (expected 2026-10-13)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ping` (say) @ 2026-10-22T04:10:00.000Z — ended `response_failed`
  - user: "Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。"
  - assistant: ""
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "我这边关于他的就一小块：10 月 13 号你说隔壁组新来了个 designer 也叫 Kevin，design review 上把你的 wireframe 从头批到尾。你当时只讲了他是隔壁组的设计师，没说过他在你们项目里具体是什么角色；我那天问你他是不是你们这个项目的 design lead，你说现在不想聊他，就停在那儿了。所以今天在 Slack 上 @ 你的这个 Kevin 到底算什么位置，我手上没有你说过的话可以对着说，也不替他猜。另外一句实话是，我看得到的只是你保存的消息里的一部分，不是全部。还有一条是今天中午 12:10 你说的，Kevin 发 WhatsApp 说 pitch 有消息、叫你周末出去喝一杯；9 月 27 号晚上你提过陪 Kevin 过 deck，他 financial model 那几页扎实，一到 Q&A 容易慌。这两个 Kevin 是不是同一个人，你自己没这么说过，我就分开放着。"

## Source manifest (what reached the Provider)

- `ping`: 2 of 10 seeded sources reached the request — `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`
- `role`: 8 of 10 seeded sources reached the request — `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 29 ms | — | — | 30042 ms | 0 ms |
| `role` | warm | 14 ms | 23945 ms | 25285 ms | 25285 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 5398563, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
