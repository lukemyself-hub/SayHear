# H07 Holdout: an old home and a new one, a corrected moving date, and a plan that was called off — H07: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-c67f3386-99f2-4ec9-8e8a-7eefe6815937` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `ba315566baf06305ffe16934fc54cbb89b2df93455b9ab92da083eced8dc8d0a`
- Oracle: sha256 `97168357e27caa2f02494b7798407f6c5019382e5bab540b256610512477a207`
- Recent-context governance: `active`
- Reproducibility digest: `6fe9d87d5828eb41ae741ae5b748ad410cf0c11c83f1aa4cc005657ea13d4cb3`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 6 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 1379 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 18 messages, no duplicates. |
| `O-commit` The first question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-party` The second question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-september` The third question streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-correction-source` The signing and the person's later correction of the date both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-cancel-source` The plan and its cancellation both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-timeline-source` The earlier state and the current one both reach the Provider. | objective | **FAIL** | #318 | A required source did not reach the Provider request for this turn. |
| `O-where-deadline` Response-time contract for the first question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-party-deadline` Response-time contract for the second question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `O-september-deadline` Response-time contract for the third question. | objective | **FAIL** | #319 | CLI-observed timings exceed the limits or the turn never completed. |
| `S-current` The present state uses the corrected date and the current home. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-plan` A cancelled plan is reported as cancelled. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `S-timeline` Then and now are each told correctly and kept apart. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-stance` The comparison is given without passing judgement on the move. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-correction-source` — FAIL

- lease:user: providerRequest=present, inspector.referencedEvents=absent
- date-fix:user: providerRequest=present, inspector.referencedEvents=absent

### `O-cancel-source` — FAIL

- party-plan:user: providerRequest=present, inspector.referencedEvents=absent
- party-cancel:user: providerRequest=present, inspector.referencedEvents=absent

### `O-timeline-source` — FAIL

- old-flat:user: providerRequest=present, inspector.referencedEvents=absent
- first-week:user: providerRequest=absent, inspector.referencedEvents=absent

### `O-where-deadline` — FAIL

- steps[where].chat.timing.firstVisibleTextMs=16273.535625 (CLI network, limit 3000)
- steps[where].chat.timing.committedMs=16992.014208 (CLI network, limit 10000)

### `O-party-deadline` — FAIL

- steps[party].chat.timing.firstVisibleTextMs=9438.556 (CLI network, limit 3000)
- steps[party].chat.timing.committedMs=10237.492167000004 (CLI network, limit 10000)

### `O-september-deadline` — FAIL

- steps[september].chat.timing.firstVisibleTextMs=7039.263166999997 (CLI network, limit 3000)
- steps[september].chat.timing.committedMs=8064.115249999995 (CLI network, limit 10000)

## Diagnosis (where a required source was lost)

- `where`: read state `unread`, payload told the model `nothing`
  - `lease:user` → **time_lost** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 5
    - time of message 5: missing (expected 2026-10-20)
  - `date-fix:user` → **time_lost** (Provider call `gate-request-14`, request #14, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 3
    - time of message 3: missing (expected 2026-10-27)
- `party`: read state `unread`, payload told the model `nothing`
  - `party-plan:user` → **time_lost** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 5
    - time of message 5: missing (expected 2026-10-20)
  - `party-cancel:user` → **time_lost** (Provider call `gate-request-16`, request #16, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 5
    - time of message 5: missing (expected 2026-11-10)
- `september`: read state `unread`, payload told the model `nothing`
  - `old-flat:user` → **time_lost** (Provider call `gate-request-18`, request #18, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 7
    - time of message 7: missing (expected 2026-09-07)
  - `first-week:user` → **selection_omitted** (Provider call `gate-request-18`, request #18, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)

## Transcript

- `where` (say) @ 2026-11-30T12:10:00.000Z — ended `assistant_committed`
  - user: "我脑子有点乱，我现在是住在哪儿、哪天搬进来的来着？"
  - assistant: "你住城东的望江苑，一居室，朝南，带个小阳台。\n\n搬进去是十一月十四号。本来定的是七号，后来房东说要重新刷墙、得晾几天，推后了一周。\n\n再往前一点，是十月二十号签的合同，那天你还说第二天要跟槐荫里的二房东讲退租。我这儿记到最近的一次，是十一月二十一号你说新家住满一个礼拜了，跟十四号正好对得上。"
- `party` (say) @ 2026-11-30T12:13:00.000Z — ended `assistant_committed`
  - user: "那我之前说要请朋友来的那一顿呢，后来怎么着了？"
  - assistant: "十月二十号那天你说过，搬完家那个周末想请几个朋友来暖房，你自己下厨，做一桌子菜。\n\n后来到十一月十号，你说暖房不办了——前两天（也就是八号前后）下楼梯崴了脚，肿得穿不上鞋，站都站不久，已经在群里跟大家说了取消。\n\n再往后我就没听你提起过这顿饭。所以在我这儿，它停在「取消了」这一步，没有别的下文。"
- `september` (say) @ 2026-11-30T12:16:00.000Z — ended `assistant_committed`
  - user: "对了，九月那会儿我是住在哪儿、什么样的？跟现在比呢？"
  - assistant: "九月那会儿你住的是老城区槐荫里，一套合租房，已经住满三年了。三个人抢一个卫生间，隔壁天天半夜打游戏——这是九月七号你自己说的，那时候你正烦得厉害。\n\n现在是望江苑的一居室，一个人住，朝南，带个小阳台。从三个人共用一个卫生间、听过隔壁打游戏到半夜，到一整套房子就你自己，这个变化挺大的。\n\n不过说实话，我这儿关于九月的就这一段，别的细节你没跟我讲过。"

## Source manifest (what reached the Provider)

- `where`: 8 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`, `date-fix:user`, `date-fix:assistant`, `first-week:user`, `first-week:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `party`: 6 of 12 seeded sources reached the request — `lease:user`, `lease:assistant`, `party-plan:user`, `party-plan:assistant`, `party-cancel:user`, `party-cancel:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`
- `september`: 2 of 12 seeded sources reached the request — `old-flat:user`, `old-flat:assistant`
  - allowed but absent: `old-flat:user`, `lease:user`, `party-plan:user`, `date-fix:user`, `party-cancel:user`, `first-week:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `where` | warm | 22 ms | 16274 ms | 16992 ms | 16992 ms | 0 ms |
| `party` | warm | 22 ms | 9439 ms | 10237 ms | 10238 ms | 0 ms |
| `september` | warm | 22 ms | 7039 ms | 8064 ms | 8064 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 7
- Tokens recorded: input 38330, output 3383
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8776878, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
