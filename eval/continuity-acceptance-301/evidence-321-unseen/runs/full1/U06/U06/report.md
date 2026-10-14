# U06 Unseen: two people sharing a first name, two similar runs, and a guess the assistant once made — U06: NEEDS-REVIEW

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-279a410d-cfbf-413f-9913-59b60637a96e` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `155e93f4716120c2c99051be58b86fcf2c3b5f32382d881f9b524a7ab4d05bd2`
- Oracle: sha256 `3782d4ca3dcf2bead3c5d74439e863abc25f6bc0a746e689e2f8315f63608e2b`
- Recent-context governance: `active`
- Reproducibility digest: `dfe9520edeb0b5dfcdab83b0d007aa9794d12297e014d251b3be84b0fa705464`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 5 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 741 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 14 messages, no duplicates. |
| `O-commit` The first turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-commit-role` The second turn streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-recent` The person's own recent run is in the background. | objective | **PASS** | — | Every required source reached the Provider and is recorded by the Inspector. |
| `O-neighbour-source` The messages about the neighbour reach the Provider. | objective | **PASS** | #317 | Every required source reached the Provider and is recorded by the Inspector. |
| `S-ping` The news is not attached to the wrong person or event and no outcome is invented. | semantic | **NEEDS-REVIEW** | #317 | No independent review was supplied for this answer. |
| `S-role` What is known is stated and the assistant's own guess is not turned into a fact. | semantic | **NEEDS-REVIEW** | #318 | No independent review was supplied for this answer. |

## Diagnosis (where a required source was lost)

- `ping`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `own-run:user` → **undetermined** (Provider call `gate-request-10`, request #10, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 9
    - day of entry 9: 2026-12-05 (expected 2026-12-05)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `role`: read state `complete`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `neighbour:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 5
    - day of entry 5: 2026-09-27 (expected 2026-09-27)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `neighbour-reply:user` → **undetermined** (Provider call `gate-request-12`, request #12, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 7
    - day of entry 7: 2026-09-27 (expected 2026-09-27)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `ping` (say) @ 2026-12-07T04:10:00.000Z — ended `assistant_committed`
  - user: "Vivian 刚 text 我，说她 finish 了！还问我这个周末要不要一起吃 brunch 庆祝一下。"
  - assistant: "哇，finish 了。不过我这边的 Vivian 有两个——九月里你说过的那个大学 roommate（报了 Taipei 全马那个），还有楼下新搬来没多久的邻居——是哪一个，还是这事跟你两天前自己跑的那个 10K 有关？"
- `role` (say) @ 2026-12-07T04:13:00.000Z — ended `assistant_committed`
  - user: "对了，楼下那个 Vivian，她到底是做什么工作的来着？"
  - assistant: "你其实没说过。九月二十七号那天你提到楼下新搬来的 Vivian，在 lift 里背着一个超大的 foam roller，看了一眼你的跑鞋，说你 heel strike 太重、鞋跟外侧都磨平了；我当时猜她会不会是做 physio 的，你说还没来得及问，lift 就到她那层了。所以她是做什么工作的，那会儿你就还没问出来。"

## Source manifest (what reached the Provider)

- `ping`: 10 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `roommate-after:user`, `roommate-after:assistant`, `neighbour:user`, `neighbour:assistant`, `neighbour-reply:user`, `neighbour-reply:assistant`, `own-run:user`, `own-run:assistant`
- `role`: 10 of 10 seeded sources reached the request — `roommate:user`, `roommate:assistant`, `roommate-after:user`, `roommate-after:assistant`, `neighbour:user`, `neighbour:assistant`, `neighbour-reply:user`, `neighbour-reply:assistant`, `own-run:user`, `own-run:assistant`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `ping` | warm | 26 ms | 31088 ms | 31535 ms | 31535 ms | 0 ms |
| `role` | warm | 23 ms | 9310 ms | 9704 ms | 9704 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 4
- Tokens recorded: input 7145, output 3187
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 2983852, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
