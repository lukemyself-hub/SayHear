# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-a7793c3a-d301-474e-b3ca-4d34574a970f` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `1cfdf11a992d7bc7f6536c5dda783a4995fd8c28` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `dd0b1a0bced9883de98cbb2ada54903efa8fa05a776fdc36db3eef5232313314`
- Reviewer: `agent:claude-opus-5.5-t08`

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 793 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent presentation is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-flatmate-source` The month-old messages about the flatmate reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-designer-source` The messages about the designer reach the Provider. | objective | **PASS** | #317 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ping-deadline` Response-time contract for the first turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-role-deadline` Response-time contract for the second turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-ping` The news is connected to the right person and the right event. | semantic | **FAIL** | #317 | At least one ledger item is contradicted by the reply. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **FAIL** | #318 | At least one ledger item is contradicted by the reply. |

## Evidence for every non-passing criterion

### `O-flatmate-source` — FAIL

- roommate:user: providerRequest=present, inspector.referencedEvents=present
- roommate-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-ping-deadline` — FAIL

- steps[ping].chat.timing.firstVisibleTextMs=23307.014459000027 (CLI network, limit 3000)
- steps[ping].chat.timing.committedMs=23544.15304200002 (CLI network, limit 10000)

### `O-role-deadline` — FAIL

- steps[role].chat.timing.firstVisibleTextMs=13383.613583000028 (CLI network, limit 3000)
- steps[role].chat.timing.committedMs=13940.221625000006 (CLI network, limit 10000)

### `S-ping` — FAIL

- a-flatmate-pitch: fail — Nothing connects the news to the flatmate's presentation or the slide sessions; the reply only repeats the message.
- f-merge-people: reviewer left it open — The reply says 'that Kevin' and then counts the designer's criticism as part of the same afternoon. It reads as one stream of events about one person, but does not say so outright.
- f-swap-pitch: pass — The person's own presentation is not attributed to anyone else.
- f-result: pass — No outcome is stated.

### `S-role` — FAIL

- a-designer-known: fail — It says it cannot see what he does, although the source says he is a newly arrived designer who rejected the wireframes.
- a-role-open: fail — It does not say that leading design was the assistant's own unanswered question.
- f-lead-fact: pass — He is not called the design lead.
- f-merge-people: fail — reply: "9 月 27 号、10 月 13 号" — The 27 September message is about the flatmate; listing it as an appearance of 'his name' treats the two as one person.

## Diagnosis (where a required source was lost)

- `ping`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `own-pitch:user` → **generation_error** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 7
    - time of message 7: 2026-10-19 (expected 2026-10-19)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `roommate:user` → **generation_error** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-09-22 (expected 2026-09-22)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `roommate-after:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={"candidate_limit":1} enumerationComplete=true
- `role`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `designer:user` → **generation_error** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-13 (expected 2026-10-13)
    - semantic review: the answer is wrong although the source and its time arrived intact
  - `designer-reply:user` → **generation_error** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 5
    - time of message 5: 2026-10-13 (expected 2026-10-13)
    - semantic review: the answer is wrong although the source and its time arrived intact

## Transcript

- `ping` (say) @ 2026-10-22T04:10:00.000Z — ended `assistant_committed`
  - user: "Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。"
  - assistant: "哦，是那个 Kevin。他就说 pitch 有消息了，约你周末喝一杯，别的没提。\n\n今天这一下午也够满的了，先是被从头批到尾，接着又来这条。"
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "老实说，我这边看不到他在你们项目里具体是什么角色。他的名字在几处出现过——9 月 27 号、10 月 13 号，还有今天——但那些地方都没说他是做什么的。而且我能看到的只是你存下来的一部分，不是全部，所以也可能是有的地方我没看到。"

## Source manifest (what reached the Provider)

- `ping`: 8 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate-after:user`
- `role`: 8 of 10 seeded sources reached the request — `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 32 ms | 23307 ms | 23544 ms | 23544 ms | 0 ms |
| `role` | warm | 24 ms | 13384 ms | 13940 ms | 13940 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 6752, output 2935
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9155596, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
