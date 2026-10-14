# H06 Holdout: two people sharing a first name, two similar presentations, and a guess the assistant once made — H06: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-05336e20-ebcb-4e80-a89a-1c3f016ad69c` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `600c061cd32839355c7036e867fa0b00d0990e2c` (working tree dirty)
- Fixture: version `final-1`, sha256 `e0316f07627df4bec48065cf746d038c884ec56c11f5ae40c29f4631cf263974`
- Oracle: sha256 `a432cb5f80be22691386bb13e0a8a421ed6d709bf7a2307b6d51f4ec33b74312`
- Recent-context governance: `active`
- Reproducibility digest: `45c8490e248b0851ed832e4e376f0aea3aade2467b5999793a62114b836fc8c3`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 753 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent presentation is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-flatmate-source` The month-old messages about the flatmate reach the Provider. | objective | **FAIL** | #317 | A required source did not reach the Provider request for this turn. |
| `O-designer-source` The messages about the designer reach the Provider. | objective | **PASS** | #317 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-ping-deadline` Response-time contract for the first turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-role-deadline` Response-time contract for the second turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-ping` The news is connected to the right person and the right event. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-flatmate-source` — FAIL

- roommate:user: providerRequest=present, inspector.referencedEvents=present
- roommate-after:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-ping-deadline` — FAIL

- steps[ping].chat.timing.firstVisibleTextMs=19930.782542 (CLI network, limit 3000)
- steps[ping].chat.timing.committedMs=20286.71304199996 (CLI network, limit 10000)

### `O-role-deadline` — FAIL

- steps[role].chat.timing.firstVisibleTextMs=19853.73100000003 (CLI network, limit 3000)
- steps[role].chat.timing.committedMs=20812.522875000024 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `ping`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `own-pitch:user` → **undetermined** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 7
    - day of entry 7: 2026-10-19 (expected 2026-10-19)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `roommate:user` → **undetermined** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-22 (expected 2026-09-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `roommate-after:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: absent
    - coverage: omitted={"candidate_limit":1} enumerationComplete=true
- `role`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `designer:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-13 (expected 2026-10-13)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `designer-reply:user` → **undetermined** (Provider call `gate-request-13`, request #13, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-10-13 (expected 2026-10-13)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ping` (say) @ 2026-10-22T04:10:00.000Z — ended `assistant_committed`
  - user: "Kevin 刚 WhatsApp 我，说 pitch 有消息了，叫我周末出去喝一杯。"
  - assistant: "他专门约你出来当面说，估计这消息有点分量。你是还不知道内容，还是已经听了个大概？"
- `role` (say) @ 2026-10-22T04:13:00.000Z — ended `assistant_committed`
  - user: "另一个 Kevin 今天又在 Slack 上 @ 我，你还记得他在我们项目里是什么角色吗？"
  - assistant: "那个 Kevin 我能对上的，是 10 月 13 号你说的:隔壁组新来了个 designer 也叫 Kevin，那天 design review 上把你的 wireframe 从头批到尾，说整个 flow 要重做。当时我问过他是不是你们这个项目的 design lead，你没接那句，只说那天不想聊他——所以他在你们项目里到底是什么角色，我这儿没有，你留下的只是「隔壁组的 designer」。再早一点，9 月 27 号还有一位 Kevin，是你陪他把 deck 从头到尾过了两遍的那位，和这个不是一回事。另外我能看到的只是你存下来的一部分，不一定全。"

## Source manifest (what reached the Provider)

- `ping`: 8 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate-after:user`
- `role`: 8 of 10 seeded sources reached the request — `roommate-after:user`, `roommate-after:assistant`, `designer:user`, `designer:assistant`, `designer-reply:user`, `designer-reply:assistant`, `own-pitch:user`, `own-pitch:assistant`
  - allowed but absent: `roommate:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 21 ms | 19931 ms | 20287 ms | 20287 ms | 0 ms |
| `role` | warm | 33 ms | 19854 ms | 20813 ms | 20813 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 6922, output 2164
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 7883024, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
