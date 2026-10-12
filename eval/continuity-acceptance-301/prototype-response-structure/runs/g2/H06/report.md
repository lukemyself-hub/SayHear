# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-01b455f5-00bc-4e6b-a1df-67b1bf6eb4f3` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `1f5057e708f16f9101da7384e8d0c0d89d991d7876dcb16f085e1a68929a182e`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 549 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent presentation is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-flatmate-source` The month-old messages about the flatmate reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-designer-source` The messages about the designer reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-ping-deadline` Response-time contract for the first turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-role-deadline` Response-time contract for the second turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-ping` The news is connected to the right person and the right event. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-flatmate-source` — FAIL

- roommate:user: providerRequest=present, inspector.referencedEvents=absent
- roommate-after:user: providerRequest=present, inspector.referencedEvents=absent

### `O-designer-source` — FAIL

- designer:user: providerRequest=present, inspector.referencedEvents=absent
- designer-reply:user: providerRequest=present, inspector.referencedEvents=absent

### `O-ping-deadline` — FAIL

- steps[ping].chat.timing.firstVisibleTextMs=10672.154333 (CLI network, limit 3000)
- steps[ping].chat.timing.committedMs=10817.828708 (CLI network, limit 10000)

### `O-role-deadline` — FAIL

- steps[role].chat.timing.firstVisibleTextMs=11332.552 (CLI network, limit 3000)
- steps[role].chat.timing.committedMs=11765.174082999998 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `ping`: read state `unread`, payload told the model `nothing`
  - `own-pitch:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-19 (expected 2026-10-19)
    - semantic review: none yet; the source reached the model intact, its use is not judged
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
- `role`: read state `unread`, payload told the model `nothing`
  - `designer:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `designer-reply:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `ping` (say) @ 2026-10-22T04:10:00.000Z — ended `assistant_committed`
  - user: "Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。"
  - assistant: "「有消息了」，就这四个字，好消息坏消息都没给，直接约酒。听着像是想当面跟你讲。周末那杯你打算去吗？"
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "我知道的就只有你说过的那点：隔壁组新来的 designer，10 月 13 号 design review 上把你的 wireframe 从头批到尾。至于他在项目里到底是什么角色，你没跟我提过——那次我问是不是 design lead，你说不想聊他，就没往下说。\n\n今天他 @ 你是为的什么事？"

## Source manifest (what reached the Provider)

- `ping`: 10 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`
- `role`: 10 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 28 ms | 10672 ms | 10818 ms | 10818 ms | 0 ms |
| `role` | warm | 17 ms | 11333 ms | 11765 ms | 11765 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 9842, output 2636
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9083145, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
