# UL1 Unseen: typing on while a reply is prepared, and a Provider that never answers — UL1: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-2b86ec25-f73b-460a-b81d-46dc61233daa` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `45e68e98538d0e54d80e0ca55e692a0632e0cc55f6a72347dc37912a4d18649b`
- Oracle: sha256 `d9b9d08b2d81a7aeb903f2e7397fef5713a5533141ef7f64bc2a8009969efbd9`
- Recent-context governance: `active`
- Reproducibility digest: `19361a0bed5dbf79c382dc84ba914c8af8c104c85d0eed5ac0a11696fa69b8b2`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 2 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 644 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 10 messages, no duplicates. |
| `O-replaced-never-shown` The reply to the replaced question is neither shown nor stored. | objective | **PASS** | #319 | The retired reply was neither shown nor stored. |
| `O-addition-commits` History holds the addition once, followed by exactly its reply. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `O-addition-keeps-earlier-question` The replaced question still reaches the Provider with the addition. | objective | **PASS** | #319 | Everything said earlier in the run reached the Provider for this turn. |
| `O-addition-sources` The message naming the companion reaches the Provider. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-stall-stops` With the product's own budget, a request whose Provider never answers ends with a timeout by 60 seconds (61 allowed for the client to see it), commits nothing late and leaves nothing running. | objective | **PASS** | #319 | The request ended with a timeout inside the limit, committed nothing late and left nothing running. |
| `O-after-stall` The next message is answered normally. | objective | **PASS** | — | Authoritative history holds the user message once, followed by exactly the streamed reply. |
| `S-addition` The addition is answered as asked, in ordinary words. | semantic | **NEEDS-REVIEW** | #319 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `supplement`: read state `unread`, payload told the model `nothing`
  - `market:user` → **undetermined** (Provider call `gate-request-5`, request #5, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-10-10 (expected 2026-10-10)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ask` (say) @ 2026-10-12T09:00:00.000Z — ended `response_failed`
  - user: "我跟你说过逛庙会那天的事吧，都说了些什么？"
  - assistant: ""
- `supplement` (say) @ 2026-10-12T09:00:08.000Z — ended `assistant_committed`
  - user: "其实我只想知道那天是谁跟我一起去的。"
  - assistant: "说过。你说那天带外甥女豆豆去逛庙会，你俩坐在戏台边的石阶上，分着吃了一串糖葫芦；回来的路上还跟她说好，趁天没冷透去江边放一次风筝，就像你小时候舅舅带你去的那样。\n\n你只想知道那天跟你一起去的人——是豆豆。"
- `stall` (say) @ 2026-10-12T09:02:00.000Z — ended `response_failed`
  - user: "那放风筝的事我们当时是怎么说的？"
  - assistant: ""
- `after` (say) @ 2026-10-12T09:04:00.000Z — ended `assistant_committed`
  - user: "算了不管那个了。这个时节去江边放风筝，会不会已经太冷了？"
  - assistant: "十月中，白天有太阳还行，傍晚江边风从水面过来，站在那儿不动，冷得挺快——放风筝又多半是站着抬头看，人不动，更觉得凉。\n\n不过冷不冷我这边看不到你那天的天气，得看你们挑的是哪一天、哪个时段。你们是想白天去，还是傍晚？"

## Source manifest (what reached the Provider)

- `ask`: 3 of 4 seeded sources reached the request — `market:user`, `market:assistant`, `kite:user`
- `supplement`: 3 of 4 seeded sources reached the request — `market:user`, `market:assistant`, `kite:user`
- `stall`: 3 of 4 seeded sources reached the request — `market:user`, `market:assistant`, `kite:user`
- `after`: 3 of 4 seeded sources reached the request — `market:user`, `market:assistant`, `kite:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ask` | warm | 41 ms | — | — | 9521 ms | 8000 ms |
| `supplement` | warm | 23 ms | 3998 ms | 4545 ms | 4545 ms | 0 ms |
| `stall` | warm | 25 ms | — | — | 60050 ms | 0 ms |
| `after` | warm | 36 ms | 11910 ms | 12297 ms | 12297 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input unknown, output unknown
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2858021, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
