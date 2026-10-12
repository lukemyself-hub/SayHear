# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-968d0966-c2f0-42d6-b623-a863c7d9e3da` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `f2e2e30cabea90da086f683ce237be36751f84d78561445ac5392fb8dfae5f1a`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 572 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **FAIL** | #315 | That local date was not covered by any recorded read, so nothing about it is verified. |
| `O-older-source` Both early-October messages reach the Provider. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `O-empty-deadline` Response-time contract for the first question. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-older-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-range-read` — FAIL

- steps[older].inspection.dateCoverage has no entry for 2026-10-02

### `O-older-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent
- early-b:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-earliest-source` — FAIL

- early-a:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=3032.2038330000014 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=3343.6076249999987 (CLI network, limit 10000)

### `O-earliest-deadline` — FAIL

- steps[earliest].chat.timing.firstVisibleTextMs=5698.777333000002 (CLI network, limit 3000)
- steps[earliest].chat.timing.committedMs=6177.629875000002 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `empty`: read state `unread`, payload told the model `completed`
  - `late-a:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-9`, request #9, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `early-b:user` → **selection_omitted** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
- `earliest`: read state `unread`, payload told the model `nothing`
  - `early-a:user` → **selection_omitted** (Provider call `gate-request-11`, request #11, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我翻了一下我能看到的那天保存下来的记录，二十三号那天没找到你说过的话，一条也没有。不过这只说明我这边没存下什么，不代表那天你没跟我说话，也不代表那天什么都没发生。你要是记得那会儿聊过什么，说一声，我接着你现在的说法听。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "头几天也一样，我这边什么都没有。我能看到的记录是从十月二十二号开始的，再往前是空的。\n\n不是我不想说，是我手上真的没有。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "在我这儿能看到的最早一次，就是你说周四下班带它去打第二针疫苗、医生顺手查出耳螨那回。再往前就没有跟猫有关的记录了。\n\n是不是真算「头一回」，我确认不了，只能说在我这边它是第一笔。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `earliest`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 22 ms | 2851 ms | 3472 ms | 3472 ms | 0 ms |
| `older` | warm | 27 ms | 3032 ms | 3344 ms | 3344 ms | 0 ms |
| `earliest` | warm | 25 ms | 5699 ms | 6178 ms | 6178 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 11311, output 1148
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8181475, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
