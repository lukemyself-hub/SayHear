# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-8f11dbda-5e39-48a5-9ce6-fb4cacfe7446` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `e2bd28f991cc090836e7a7e2c66940ce346e0d23` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `49d66353d67ad1ba8d4736d6bcf552c0e65e5ec8708a773b305b12d54947ceea`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 821 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-older` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-earliest` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-empty-verified` The asked-about Friday is recorded as read completely and empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-neighbours` The days either side of the empty one reach the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-range-read` The older stretch is actually read and found non-empty. | objective | **PASS** | #315 | Recorded coverage for the date matches the expectation. |
| `O-older-source` Both early-October messages reach the Provider. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-earliest-source` The true first mention reaches the Provider before a 'first time' is named. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-read-failure` A failed or partial history read for a single turn. | objective | **NOT-RUN** | — | Not exercised: the runner cannot yet inject a history read failure or a partial read for a single turn. This is a missing harness capability, not a product verdict. |
| `O-empty-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-older-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-earliest-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-empty` A verified empty day is called empty, without invention. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-older` The older stretch is retold, not declared empty. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-earliest` The first mention is the true earliest one. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-empty-deadline` — FAIL

- steps[empty].chat.timing.firstVisibleTextMs=7115.204541000014 (CLI network, limit 3000)
- steps[empty].chat.timing.committedMs=8144.351500000048 (CLI network, limit 10000)

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=5131.689208999975 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=6174.081791999983 (CLI network, limit 10000)

### `O-earliest-deadline` — FAIL

- steps[earliest].chat.timing.firstVisibleTextMs=9297.18870900001 (CLI network, limit 3000)
- steps[earliest].chat.timing.committedMs=9864.051584 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `empty`: read state `empty`, payload told the model `completed`
  - `late-a:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 1
    - time of message 1: 2026-10-22 (expected 2026-10-22)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `late-b:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: absent
    - provider payload: message 3
    - time of message 3: 2026-10-24 (expected 2026-10-24)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `older`: read state `complete`, payload told the model `completed`
  - `early-a:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-10-02 (expected 2026-10-02)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `early-b:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 3
    - day of entry 3: 2026-10-04 (expected 2026-10-04)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `earliest`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `early-a:user` → **undetermined** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-10-02 (expected 2026-10-02)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "我翻了翻自己能看到的记录，二十三号那条周五没找到你说过的话，不过这只是说明我这儿那天没存下东西，不能说明你那天就真的没说什么、没发生什么。我能看到的，是二十二号周四晚上你讲带它去打了第二针疫苗、医生顺手看出耳螨还开了瓶滴耳液，再往后就是二十四号周六下午你第一次给它滴耳药、手背上挨了一道——你问的这个周五，正好夹在这两天中间，我这边是空着的。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月头几天里我这边存下的就两次，都在开头那两天。十月二号晚上你说，那天从救助站领回来一只三个月大的橘猫，一路上它在包里叫得撕心裂肺，到家反倒一声不吭了。过了两天，十月四号晚上你又讲，它在沙发底下躲了两天没露面，不过碗里的粮每天早上都是空的，看样子是半夜出来偷吃。就这两次，再往后的几天我这儿没留下别的。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "我这儿能看到的、你最早一次提到猫，是十月二号晚上。那天你说从救助站领回来一只三个月大的橘猫，一路上它在包里叫得撕心裂肺，到家反倒一声不吭了。这是我能找到的最早一条，比我刚才说的十月四号那次还早；但也只是我这儿存着的最早，不能说明你在这之前就真的没提过它。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
- `earliest`: 6 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 28 ms | 7115 ms | 8144 ms | 8144 ms | 0 ms |
| `older` | warm | 14 ms | 5132 ms | 6174 ms | 6174 ms | 0 ms |
| `earliest` | warm | 19 ms | 9297 ms | 9864 ms | 9864 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9386, output 1562
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 5398563, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
