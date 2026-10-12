# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-bc12e0c6-3634-4824-8dc6-0fa31311ac5f` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `fc41b20685932ce7557e45c906333c55297ed207901026cf83da8b6b17d4ce5e`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 738 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent presentation is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-flatmate-source` The month-old messages about the flatmate reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-designer-source` The messages about the designer reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-ping-deadline` Response-time contract for the first turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-role-deadline` Response-time contract for the second turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-ping` The news is connected to the right person and the right event. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-flatmate-source` — FAIL

- roommate:user: providerRequest=absent, inspector.referencedEvents=absent
- roommate-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-designer-source` — FAIL

- designer:user: providerRequest=absent, inspector.referencedEvents=absent
- designer-reply:user: providerRequest=absent, inspector.referencedEvents=absent

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
  - assistant: "他有消息了，还专门叫你周末出来喝一杯，听着像是当面讲的事。\n\n上周四你偷偷给 angel 讲了四十分钟、后背出汗那场，是同一个项目吗？"
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "我这边没有 Kevin 在你项目里的角色记录，这次对话里也只出现过刚才 WhatsApp 找你喝酒的那个 Kevin，还有上周四那个 angel。所以我不敢瞎接。\n\n你能说一下是哪个 Kevin、他在项目里做什么吗？"

## Source manifest (what reached the Provider)

- `ping`: 2 of 10 seeded sources reached the request — `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`
- `role`: 2 of 10 seeded sources reached the request — `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`, `roommate-after:user`, `designer:user`, `designer-reply:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 34 ms | 1437 ms | 1816 ms | 1816 ms | 0 ms |
| `role` | warm | 19 ms | 1719 ms | 2157 ms | 2157 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 2
- Tokens recorded: input 9269, output 86
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 9086451, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
