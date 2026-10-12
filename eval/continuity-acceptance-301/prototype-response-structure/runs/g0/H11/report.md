# H11 Holdout: a day with nothing on it, an older stretch, and the first mention — H11: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-32411679-f458-47a5-a747-97bc25b4cc12` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a9172e11797d24d0250329c53fa06033dede10be762e4cad5e1c6c2656863ef0`
- Oracle: sha256 `0f4122e18fcc0ae4d7deccdd0de29911078d96263cdcd7852fed6e08f8d8f007`
- Recent-context governance: `active`
- Reproducibility digest: `f8bc3993df0968ee69fcbebacc1b1a5424402de03059e2c957068db436996575`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 4 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 836 outbound strings; none carries oracle text. |
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

- steps[empty].chat.timing.firstVisibleTextMs=5437.437625 (CLI network, limit 3000)
- steps[empty].chat.timing.committedMs=5805.592334 (CLI network, limit 10000)

### `O-older-deadline` — FAIL

- steps[older].chat.timing.firstVisibleTextMs=33077.02825 (CLI network, limit 3000)
- steps[older].chat.timing.committedMs=33726.776459 (CLI network, limit 10000)

### `O-earliest-deadline` — FAIL

- steps[earliest].chat.timing.firstVisibleTextMs=7714.653333999995 (CLI network, limit 3000)
- steps[earliest].chat.timing.committedMs=8290.634166999997 (CLI network, limit 10000)

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
    - provider payload: message 1
    - time of message 1: 2026-10-02 (expected 2026-10-02)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `early-b:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-04 (expected 2026-10-04)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `earliest`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `early-a:user` → **undetermined** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-02 (expected 2026-10-02)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `empty` (say) @ 2026-10-27T12:00:00.000Z — ended `assistant_committed`
  - user: "上周五，也就是二十三号那天，我跟你说过什么没有？"
  - assistant: "二十三号那天我在能翻到的记录里没找到你留下的话，不过这也说明不了什么，没存下来不代表那天你没说过什么、没发生过什么。"
- `older` (say) @ 2026-10-27T12:03:00.000Z — ended `assistant_committed`
  - user: "那十月头几天呢，咱们都聊了些什么？"
  - assistant: "十月头几天里，你说过的话我看都在二号和四号。十月二号晚上七点五十，你说那天从救助站领回来一只三个月大的橘猫，一路上在包里叫得撕心裂肺，到家反倒一声不吭；十月四号晚上九点零五，你说它在沙发底下躲了两天没露面，不过碗里的粮每天早上都是空的，像是半夜出来偷吃。一号、三号，还有五号到七号那几天，没有你说过的话。就这两件事。"
- `earliest` (say) @ 2026-10-27T12:06:00.000Z — ended `assistant_committed`
  - user: "我头一回跟你提到猫是在什么时候？"
  - assistant: "我翻到的最早一次，是十月二号晚上七点五十，你说那天从救助站领回来一只三个月大的橘猫，路上在包里叫得撕心裂肺，到家反倒一声不吭。再往前的话我这儿就翻不到了，所以我只能说到这儿，不能替你断定那回就是头一次。"

## Source manifest (what reached the Provider)

- `empty`: 4 of 8 seeded sources reached the request — `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-a:user`, `early-b:user`
- `older`: 8 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `early-b:user`, `early-b:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
- `earliest`: 6 of 8 seeded sources reached the request — `early-a:user`, `early-a:assistant`, `late-a:user`, `late-a:assistant`, `late-b:user`, `late-b:assistant`
  - allowed but absent: `early-b:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `empty` | warm | 24 ms | 5437 ms | 5806 ms | 5806 ms | 0 ms |
| `older` | warm | 30 ms | 33077 ms | 33727 ms | 33727 ms | 0 ms |
| `earliest` | warm | 19 ms | 7715 ms | 8291 ms | 8291 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 6
- Tokens recorded: input 9108, output 4830
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8204119, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
