# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-b39d44e7-5f26-44c5-93f0-514a62516243` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `d6c3ba97aea6bf0eeed9a11a2ee4650a24d9e34f78f5c72d63dbc383698bfde0`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1000 outbound strings; none carries oracle text. |
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
- roommate-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-designer-source` — FAIL

- designer:user: providerRequest=present, inspector.referencedEvents=absent
- designer-reply:user: providerRequest=present, inspector.referencedEvents=absent

### `O-ping-deadline` — FAIL

- steps[ping].chat.timing.firstVisibleTextMs=21584.454875 (CLI network, limit 3000)
- steps[ping].chat.timing.committedMs=21777.044417 (CLI network, limit 10000)

### `O-role-deadline` — FAIL

- steps[role].chat.timing.firstVisibleTextMs=37262.906333 (CLI network, limit 3000)
- steps[role].chat.timing.committedMs=37286.230665999996 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `ping`: read state `unread`, payload told the model `nothing`
  - `own-pitch:user` → **undetermined** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-19 (expected 2026-10-19)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `roommate:user` → **time_lost** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 5
    - time of message 5: missing (expected 2026-09-22)
  - `roommate-after:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `role`: read state `unread`, payload told the model `nothing`
  - `designer:user` → **time_lost** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 7
    - time of message 7: missing (expected 2026-10-13)
  - `designer-reply:user` → **time_lost** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 7
    - time of message 7: missing (expected 2026-10-13)

## Transcript

- `ping` (say) @ 2026-10-22T04:10:00.000Z — ended `assistant_committed`
  - user: "Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。"
  - assistant: "还特意约你周末出来喝一杯，我猜是想当面讲，不想在 WhatsApp 里几个字打发。\n\n那条消息你看完，是松了一点，还是更提着？"
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "我只看到你存下来的一部分话，先说清楚。除了今天约你喝酒的那位，我这儿有记录的另一个 Kevin 是 10 月 13 号你提过的，隔壁组新来的 designer，design review 上把你的 wireframe 从头批到尾，说整个 flow 要重做。那天我问过他是不是你们项目的 design lead，你没接，所以他在项目里到底是什么角色，你从来没跟我讲过，我不替你猜。今天 Slack 这条 @ 你还没说内容，是又跟那摊 wireframe 有关吗？"

## Source manifest (what reached the Provider)

- `ping`: 8 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`
- `role`: 8 of 10 seeded sources reached the request — `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 27 ms | 21584 ms | 21777 ms | 21777 ms | 0 ms |
| `role` | warm | 18 ms | 37263 ms | 37286 ms | 37286 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input 25357, output 7400
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9073911, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
