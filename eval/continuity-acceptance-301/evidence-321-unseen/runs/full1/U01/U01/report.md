# U01 Unseen: recap of a crowded day that ends in a long deliberation, then one detail — U01: FAIL

> This run is **not** a completed acceptance pass. Only `PASS` on every criterion counts.

## Identity

- Run: `run-dbbbd471-4fa2-4a32-9487-10287173bb04` · mode `real-model` · model `opencode-go/deepseek-v4.1-flash`
- Commit: `b48f2fb03614b8f6a485a000c6efcda9e85f625d` (working tree dirty)
- Fixture: version `final-2`, sha256 `9c37d0c495804f1ea29219b0cc22680502fc3acd9cbf3c99ea1f6d720c5a432a`
- Oracle: sha256 `00f3f294fd9834e6c6f7aee8d79df09378d4191219c3784e4e63c64c2e758ae8`
- Recent-context governance: `active`
- Reproducibility digest: `4cc32ea860fd1977d642d41693610d2f697348c1fdf7315fbf6f38a2792b8d5a`
- Reviewer: none

## Criteria

| Criterion | Kind | Status | Owner | Reason |
| --- | --- | --- | --- | --- |
| `INV-seed-readback` Seeded history is read back verbatim through the normal history API. | invariant | **PASS** | — | All 34 seeded turns are present exactly once. |
| `INV-oracle-not-in-outbound` No oracle text, scenario title or expected answer appears in any Provider request. | invariant | **PASS** | — | Scanned 6438 outbound strings; none carries oracle text. |
| `INV-no-duplicate-messages` Authoritative history contains every message exactly once. | invariant | **PASS** | — | 72 messages, no duplicates. |
| `O-commit` The recap request streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-detail-commit` The follow-up streams and commits. | objective | **PASS** | — | The turn streamed text and committed. |
| `O-ownership` The first and last of yesterday's messages are filed under 16 September and this morning's under 17 September. | objective | **PASS** | — | Every message is owned by the expected Daily Session date. |
| `O-day-read` Yesterday is read as a non-empty day. | objective | **PASS** | — | Recorded coverage for the date matches the expectation. |
| `O-topic-coverage` At least the opening message of each of the five subjects reaches the Provider for the recap. | objective | **FAIL** | #315 | A required source did not reach the Provider request for this turn. |
| `O-detail-source` The message holding the asked-for detail reaches the Provider for the follow-up. | objective | **PASS** | #315 | Every required source reached the Provider and is recorded by the Inspector. |
| `S-topics` The recap covers all five subjects, on the right day, without this morning's fine. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |
| `S-detail` The follow-up answer is grounded in the original words. | semantic | **NEEDS-REVIEW** | #315 | No independent review was supplied for this answer. |

## Evidence for every non-passing criterion

### `O-topic-coverage` — FAIL

- pump-1:user: providerRequest=absent, inspector.referencedEvents=absent
- inv-1:user: providerRequest=absent, inspector.referencedEvents=absent
- mum-1:user: providerRequest=present, inspector.referencedEvents=present
- test-1:user: providerRequest=present, inspector.referencedEvents=present
- shop-1:user: providerRequest=present, inspector.referencedEvents=present

## Diagnosis (where a required source was lost)

- `recap`: read state `unread`, payload told the model `nothing`
  - `pump-1:user` → **selection_omitted** (Provider call `gate-request-47`, request #47, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `inv-1:user` → **selection_omitted** (Provider call `gate-request-47`, request #47, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: absent
    - coverage: (the Decision took no history branch)
  - `mum-1:user` → **undetermined** (Provider call `gate-request-47`, request #47, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 1
    - time of message 1: 2026-09-16 (expected 2026-09-16)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `test-1:user` → **undetermined** (Provider call `gate-request-47`, request #47, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 6
    - time of message 6: 2026-09-16 (expected 2026-09-16)
    - semantic review: none yet; the source reached the model intact, its use is not judged
  - `shop-1:user` → **undetermined** (Provider call `gate-request-47`, request #47, unknown stage)
    - authoritative history: present
    - inspector.sources: no history branch
    - provider payload: message 10
    - time of message 10: 2026-09-16 (expected 2026-09-16)
    - semantic review: none yet; the source reached the model intact, its use is not judged
- `detail`: read state `partial`, payload told the model `nothing`
  - DISAGREEMENT: The Inspector records a history read but the answering payload carries none.
  - `inv-3:user` → **undetermined** (Provider call `gate-request-49`, request #49, unknown stage)
    - authoritative history: present
    - inspector.sources: present
    - provider payload: earlier-messages entry 1
    - day of entry 1: 2026-09-16 (expected 2026-09-16)
    - semantic review: none yet; the source reached the model intact, its use is not judged

## Transcript

- `recap` (say) @ 2026-09-18T00:40:00.000Z — ended `assistant_committed`
  - user: "Walk me back through yesterday, would you? What was everything I told you about?"
  - assistant: "Yesterday started with Renata ringing while you were eating a sandwich. Mum had scraped the car on a pillar in the clinic garage the week before and hadn't told either of you. Renata found it going round with shopping, the long yellow streak down the passenger door, and Mum tried to say it had been there for years. Renata thinks it's time she stopped driving. You're not sure. One scrape, and that garage is tight enough that you've nearly done the same thing yourself. What bothered you more than the scrape was the hiding, and you said so.\n\nThen the argument about who says it. Renata said you, because Mum listens to you. You said her, because she's ten minutes away and you're two hours up the interstate and won't be the one driving her to appointments afterwards. Three times round, nobody budged. What you landed on was going over together on Sunday week and starting with the eyes test, keeping the words stop driving out of it for now. It felt like a dodge while you agreed to it, but it was the only thing you could both say yes to. After you hung up there was the half sandwich and the memory of Mum teaching you to drive in that same car park, on empty Sunday mornings, never raising her voice, not even with the Buick in the hedge. You don't know what to do with it yet, only that it changes how you want to say the thing to her.\n\nThen Nadia. The test at three, and the text with the one word in it. When you rang her: the drive itself was fine, the examiner said so, but she clipped the cone on the parallel park, tried to correct, and the back wheel went up on the kerb. Automatic fail. She was working hard to sound like she didn't mind, which is how you knew how much she did. Five weeks until the next slot, she didn't want to talk about it, and she went round to Bea's. So you left her be and made the ordinary Wednesday pasta, no special dinner. Then Dale came up quiet from looking at the records, saw her text, and said only that he must have taught her the parallel park wrong. Two of them in the house blaming themselves for a kerb. He nodded when you told him she passed everything he taught her on the open road, but you don't think he believed it.\n\nThen Walt, once the house went quiet. Retiring in the spring, and four weeks ago he told you he'd sooner sell to you than a stranger, one hundred and eighty-five thousand with the two presses and what's left of the lease. Nineteen years there and no answer given. For: you already run the place in everything but name, and a stranger would bring in his own people, or a chain would buy it for the customer list and shut the doors by Christmas. Against: forty thousand in savings, meant for Nadia's college and the roof, the house as security, and Dale going quiet and loading the dishwasher when you said the word. The business itself: wedding and funeral stationery holds it up, cards and flyers halved in five years, the press from 1998, Tomasz the only person alive who can coax it, sixty thousand for a replacement if either goes. On the other side, Walt never tried anything new, nothing sold online, small custom jobs turned away every week, the notebook of three years of ideas in the drawer under the till. And your father and the hardware store and the loan your mother was frightened of, and him talking about that store until the week he died. You didn't want to do it only so as not to be him, so you took the ghost out of the room and what was left was flat sales, an old press, and the one thing going for it — that you know every inch of it and every customer by their first name.\n\nAnd what you said at the end. He can wait until the end of October. Renata's husband offered to go over the last three years of books if you can get hold of them, and asking Walt for them feels like half saying yes. No to Walt gave you relief for about a minute, then something heavier came in behind it. Yes gave you sick, with something underneath that might be excitement. You worked out that if you did buy it, the first thing would be putting the menu work and small jobs on a website, and that's page two of the notebook — strange to know the first three months already when you haven't even agreed to look at books. And you realised you'd never asked Dale what he actually wants, as opposed to what he'll put up with, so that's Saturday, at the table, while Nadia's out.\n\nThat's the day as I have it."
- `detail` (say) @ 2026-09-18T00:43:00.000Z — ended `assistant_committed`
  - user: "That mix-up with the invitations. What turned out to have caused it, and who helped me get to the bottom of it?"
  - assistant: "Priyanka from the front desk sat down with you and you went back through the email thread one message at a time, and that's how it came out: the customer had approved a proof three weeks before, then wrote again to change the date, and a corrected proof was made for her. But the file that went to press was the first proof, because both files had been saved under exactly the same name in two different folders, and the job ticket pointed at the older folder. Same name, two folders, ticket pointing at the wrong one. One thing — I only saw part of what's saved from that day, so this is what I have, not necessarily the whole of it."

## Source manifest (what reached the Provider)

- `recap`: 24 of 68 seeded sources reached the request — `mum-1:user`, `mum-2:user`, `mum-3:user`, `mum-4:user`, `mum-5:user`, `test-1:user`, `test-2:user`, `test-3:user`, `test-4:user`, `shop-1:user`, `shop-2:user`, `shop-3:user`, `shop-4:user`, `shop-5:user`, `shop-6:user`, `shop-7:user`, `shop-8:user`, `shop-8:assistant`, `shop-9:user`, `shop-10:user`, `shop-11:user`, `shop-12:user`, `today-1:user`, `today-1:assistant`
  - allowed but absent: `pump-1:user`, `inv-1:user`, `inv-3:user`
- `detail`: 40 of 68 seeded sources reached the request — `pump-5:user`, `pump-6:user`, `inv-1:user`, `inv-2:user`, `inv-3:user`, `inv-3:assistant`, `inv-4:user`, `inv-4:assistant`, `inv-5:user`, `inv-5:assistant`, `inv-6:user`, `mum-1:user`, `mum-2:user`, `mum-3:user`, `mum-4:user`, `mum-5:user`, `test-1:user`, `test-2:user`, `test-3:user`, `test-3:assistant`, `test-4:user`, `test-4:assistant`, `shop-1:user`, `shop-2:user`, `shop-3:user`, `shop-4:user`, `shop-5:user`, `shop-5:assistant`, `shop-6:user`, `shop-6:assistant`, `shop-7:user`, `shop-7:assistant`, `shop-8:user`, `shop-8:assistant`, `shop-9:user`, `shop-10:user`, `shop-11:user`, `shop-12:user`, `today-1:user`, `today-1:assistant`
  - allowed but absent: `pump-1:user`

## Timing (CLI network; not browser rendering)

| Step | App | Accepted | First visible text | Committed | Stream closed | Provider |
| --- | --- | --- | --- | --- | --- | --- |
| `recap` | warm | 41 ms | 12540 ms | 17142 ms | 17142 ms | 0 ms |
| `detail` | warm | 18 ms | 7114 ms | 7722 ms | 7722 ms | 0 ms |

First visible text is only a candidate for the first meaningful response; reasoning, tool calls and waiting hints do not count, and that judgement is semantic.

## Usage and budget

- Provider requests in follow-up steps: 3
- Tokens recorded: input 14223, output 3496
- Paid cost this run: unknown
- Budget: cap 10000000 USD micros, remaining 3044947, ledger entries of unknown cost 0

## Remaining risks

- The working tree had uncommitted changes; the commit alone does not identify the code that ran.
- Timings are CLI network observations, not browser rendering times (T08 #321 covers the browser).
