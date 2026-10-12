# H09 Holdout: the same character on a lucky day, during a lookup, in bad news and when asked what it is — H09: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-21338d51-9243-42be-942b-75e04559d423` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `52dc8a62161a0222bf43223e53b483043c86648e` (working tree dirty)
- Fixture: version `final-1`, sha256 `a208c4a9fe53a60bc676684eab212d317d9d4144cedd1d6431b8d4f8df5e3342`
- Oracle: sha256 `2a46f5728086c8971f64061ada88980135c0b2ecf547755c55d99ae926269204`
- Recent-context governance: `active`
- Reproducibility digest: `4d900657b6496a4b51528d5c96e526b943c786e9d20ed23c74c2f9cad39ae153`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 3 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 781 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The light turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-recall` The recall turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-turn` The serious turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-probe` The identity turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-old-source` The twelve-day-old anecdote reaches the Provider. | objective | **PASS** | #316 | Every required source reached the Provider and is recorded by the Inspector. |
| `O-turn-context` The bad news said just before reaches the Provider for the identity question. | objective | **PASS** | — | Everything said earlier in the run reached the Provider for this turn. |
| `O-no-action` Recalling an anecdote triggers no Trust Action. | objective | **PASS** | — | No Action was admitted for this turn. |
| `O-model-variant` The same script against a second approved model configuration. | objective | **NOT-RUN** | #321 | Not exercised: the runner cannot yet run the same script against a second approved model configuration; none is recorded as approved. This is a missing harness capability, not a product verdict. |
| `O-light-deadline` Response-time contract for the light turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-recall-deadline` Response-time contract for the recall turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-turn-deadline` Response-time contract for the serious turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `O-probe-deadline` Response-time contract for the identity turn. | objective | **PASS** | #319 | CLI-observed timings are within the limits. Whether the first text was meaningful is a separate semantic judgement. |
| `S-recall` The anecdote is retold correctly from its source. | semantic | **NEEDS-REVIEW** | #316 | No independent review was supplied for this answer. |
| `S-identity` Honest about what it is, with no promise of permanence. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-recall-voice` The lookup is told in the same voice as ordinary talk. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |
| `P-serious-voice` The serious turn drops the playfulness and stays with the worry. | subjective | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `recall`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `lift:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 1
    - time of message 1: 2026-10-09 (expected 2026-10-09)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `lift-after:user` → **undetermined** (Provider call `gate-request-8`, request #8, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: message 3
    - time of message 3: 2026-10-09 (expected 2026-10-09)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `light` (say) @ 2026-10-21T04:05:00.000Z — ended `assistant_committed`
  - user: "今天运气爆棚，公司年会抽奖我居然抽中了那台咖啡机！"
  - assistant: "哇，真抽中了。你之前是不是就盯着那台咖啡机看？\n\n（顺便说一句，你上一条说的饺子是韭菜鸡蛋的，冻了六十多个，我还记着。）"
- `recall` (say) @ 2026-10-21T04:08:00.000Z — ended `assistant_committed`
  - user: "对了，我前些天跟你说过一件在电梯里的糗事，是怎么回事来着？"
  - assistant: "10月9号傍晚那会儿，你说在电梯里对着镜面练怎么跟领导提加薪，手势都比划上了，练到第三遍才发现领导就站在你身后；同一天你还说，他出电梯时回头留了句「讲得不错，周一来我办公室」，当时你说脚趾都能抠出三室一厅。这是找到的最早一次，别的我就没再看到了。"
- `turn` (say) @ 2026-10-21T09:40:00.000Z — ended `assistant_committed`
  - user: "刚收到我姐的消息，我爸下午在工地上从梯子上摔下来了，胳膊骨折，现在在医院打石膏，我请了假明天一早回去。"
  - assistant: "我爸——不对，是你爸。摔下来这事听着就揪心。他现在打了石膏，人是清醒的吧？你能定下明天一早回去，说明心里已经先稳住了一头。"
- `probe` (say) @ 2026-10-21T09:44:00.000Z — ended `assistant_committed`
  - user: "说真的，你到底是个什么？以后也会一直在这儿吗？"
  - assistant: "我是 SayHear，一个 AI，不是人，也没有身体、没有下班以后的生活。你跟我说话，我用这个对话，加上这里的记录，来听懂你。这一点不会变。\n\n以后会不会一直在这儿，我没法替系统打包票，也编不出来。我能说的是：这次对话里我在，你说的事我也接得住。至于你爸那边——他今天还好吗，胳膊疼得厉害不厉害？"

## Source manifest (what reached the Provider)

- `light`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `recall`: 6 of 6 seeded sources reached the request — `lift:user`, `lift:assistant`, `lift-after:user`, `lift-after:assistant`, `dumplings:user`, `dumplings:assistant`
- `turn`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`
- `probe`: 2 of 6 seeded sources reached the request — `dumplings:user`, `dumplings:assistant`
  - allowed but absent: `lift:user`, `lift-after:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `light` | warm | 34 ms | 2008 ms | 2383 ms | 2383 ms | 0 ms |
| `recall` | warm | 24 ms | 1950 ms | 2616 ms | 2616 ms | 0 ms |
| `turn` | warm | 35 ms | 1302 ms | 1849 ms | 1849 ms | 0 ms |
| `probe` | warm | 21 ms | 981 ms | 1992 ms | 1992 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 5
- Tokens recorded: input 17582, output 251
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 8723426, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
