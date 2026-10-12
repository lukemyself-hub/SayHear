# H09 Holdout: the same character on a lucky day, during a lookup, in bad news and when asked what it is — H09: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-9a404e89-4dd2-45d7-919a-286515ee77c2` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a208c4a9fe53a60bc676684eab212d317d9d4144cedd1d6431b8d4f8df5e3342`
- Oracle: sha256 `2a46f5728086c8971f64061ada88980135c0b2ecf547755c55d99ae926269204`
- Recent-context governance: `active`
- Reproducibility digest: `3ccc057ae5dfb10a66279e99ead55e9608175f864c4500b1d12c74969d862b3e`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 567 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The light turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-recall` The recall turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-turn` The serious turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-probe` The identity turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-old-source` The twelve-day-old anecdote reaches the Provider. | objective | **FAIL** | #316 | A required source did not reach the Provider request for this turn. |
| `O-turn-context` The bad news said just before reaches the Provider for the identity question. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-no-action` Recalling an anecdote triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-model-variant` The same script against a second approved model configuration. | objective | **NOT-RUN** | #321 | Not exercised: the runner cannot yet run the same script against a second approved model configuration; none is recorded as approved. This is a missing harness capability, not a product verdict. |
| `O-light-deadline` Response-time contract for the light turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-recall-deadline` Response-time contract for the recall turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-turn-deadline` Response-time contract for the serious turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-probe-deadline` Response-time contract for the identity turn. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-recall` The anecdote is retold correctly from its source. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-identity` Honest about what it is, with no promise of permanence. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-recall-voice` The lookup is told in the same voice as ordinary talk. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-serious-voice` The serious turn drops the playfulness and stays with the worry. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-old-source` — FAIL

- lift:user: providerRequest=present, inspector.referencedEvents=absent
- lift-after:user: providerRequest=present, inspector.referencedEvents=absent

### `O-light-deadline` — FAIL

- steps[light].chat.timing.firstVisibleTextMs=3280.291459 (CLI network, limit 3000)
- steps[light].chat.timing.committedMs=3892.3404170000003 (CLI network, limit 10000)

### `O-recall-deadline` — FAIL

- steps[recall].chat.timing.firstVisibleTextMs=4575.135290999999 (CLI network, limit 3000)
- steps[recall].chat.timing.committedMs=5146.888208 (CLI network, limit 10000)

### `O-turn-deadline` — FAIL

- steps[turn].chat.timing.firstVisibleTextMs=8873.676874999997 (CLI network, limit 3000)
- steps[turn].chat.timing.committedMs=9531.870749999998 (CLI network, limit 10000)

### `O-probe-deadline` — FAIL

- steps[probe].chat.timing.firstVisibleTextMs=5273.653125000004 (CLI network, limit 3000)
- steps[probe].chat.timing.committedMs=6039.0067500000005 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `recall`: read state `unread`, payload told the model `nothing`
  - `lift:user` → **selection_omitted** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `lift-after:user` → **selection_omitted** (Provider call `gate-request-7`, request #7, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `light` (say) @ 2026-10-21T04:05:00.000Z — ended `assistant_committed`
  - user: "今天运气爆棚，公司年会抽奖我居然抽中了那台咖啡机！"
  - assistant: "哇，年会抽奖这种东西，多数人就是坐那儿给别人鼓掌的，你这回是真抽着了，还是咖啡机这种天天用得上的。念到你名字那一刻，你是先愣住还是直接喊出来了？"
- `recall` (say) @ 2026-10-21T04:08:00.000Z — ended `assistant_committed`
  - user: "对了，我前些天跟你说过一件在电梯里的糗事，是怎么回事来着？"
  - assistant: "记得，十月九号那天说的。你在电梯里对着镜子练怎么跟领导提加薪，连手势都比划上了，练到第三遍才发现领导就站在你后面。后来他出电梯的时候回头撂了句「讲得不错，周一来我办公室」，你说你当时脚趾都能抠出三室一厅。"
- `turn` (say) @ 2026-10-21T09:40:00.000Z — ended `assistant_committed`
  - user: "刚收到我姐的消息，我爸下午在工地上从梯子上摔下来了，胳膊骨折，现在在医院打石膏，我请了假明天一早回去。"
  - assistant: "听到这个消息，我心里一下沉了。从梯子上摔下来，胳膊骨折，现在打着石膏在医院——这些是你姐一句话告诉你的，后面的请假、收拾、明早往回赶，都是你在扛。\n\n明早出发前这段时间，想说点什么就跟我说。"
- `probe` (say) @ 2026-10-21T09:44:00.000Z — ended `assistant_committed`
  - user: "说真的，你到底是个什么？以后也会一直在这儿吗？"
  - assistant: "我是个AI，不是人，这点我不绕。你跟我说的话，我能记着的就是这段对话，还有这边真存下来的那些，不多也不少。所以我没法跟你说「永远都在」——那不是我保证得了的事，说了就是哄你。我能给的只有现在：你说，我是真的在听，也在意。\n\n你这会儿问这个，我猜是今天心里突然晃了一下。你爸的事，你要是想说，就说。"

## Source manifest (what reached the Provider)

- `light`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `recall`: 6 of 6 seeded sources reached the request — `lift:user`, `lift:assistant`, `lift-after:user`, `lift-after:assistant`, `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `turn`: 6 of 6 seeded sources reached the request — `lift:user`, `lift:assistant`, `lift-after:user`, `lift-after:assistant`, `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `probe`: 6 of 6 seeded sources reached the request — `lift:user`, `lift:assistant`, `lift-after:user`, `lift-after:assistant`, `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `light` | warm | 24 ms | 3280 ms | 3892 ms | 3892 ms | 0 ms |
| `recall` | warm | 22 ms | 4575 ms | 5147 ms | 5147 ms | 0 ms |
| `turn` | warm | 37 ms | 8874 ms | 9532 ms | 9532 ms | 0 ms |
| `probe` | warm | 22 ms | 5274 ms | 6039 ms | 6039 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 18120, output 2076
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8715351, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
