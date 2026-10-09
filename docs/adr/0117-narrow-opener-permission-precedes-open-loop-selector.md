---
status: accepted
date: 2026-08-26
---

# Narrow opener permission precedes the open-loop selector

> 2026-10-07：[ADR-0149](0149-recent-conversation-context-is-bounded-source-history.md)
> 修订无检索信号时的近期背景合同，每轮自动带入预算内的近期原文；长期 Claim 的词面
> 检索仍可返回零条，打招呼也不要求提旧事。下文为原决定记录；G2 / Open Loop 运行时
> 已由 [ADR-0141](0141-g1-only-release-after-g2-retirement.md) 退役，不因本次修订恢复。

In 1A.3a, the only cross-recall-surface capability added beyond settled law is a prompt-contract
permission: the Assistant may naturally respond to whatever memory was actually injected — a
Person Portrait item or a query-retrieved thread — including at the conversation opening or the
first substantive exchange, using the natural friend-like language of ADR-0116. No selector
machinery lands in 1A.3a: none of the fail-closed Open Loop gates, no
`ProactiveFollowupStateVersion`, no per-exchange quota, no deterministic suppression state. The
full Proactive Memory Follow-up / Open Loop selector stays scoped to 1A.3b unchanged per
ADR-0113.

The seed-94 blind pairwise run (`eval/recall-presentation-94/`) decided this. Proactive
continuity decisively outranked restraint at high-stakes moments, and with passive injection
alone the model produced vague hints (“暗示昨天的挂念，但没有明确点出来”) that scored worse than
explicit asks. Yet pulling forward any part of the selector would duplicate 1A.3b work; wording
lives in versioned prompt artifacts, so nothing built now gets thrown away, and the behavior
fixtures written against it remain valid regression coverage once the full selector arrives.

Two boundaries are deliberate. First, lexical lanes only fire on real signals: an opening turn
with no entity/time-term signal (e.g. a bare greeting) legitimately yields zero injection and no
displayed continuity until 1A.3b — this must be evaluated as correct behavior, not a miss.
Second, until 1A.3b adds the deterministic deflection-suppression projection, stop-of-direction
enforcement for these opener mentions is prompt-enforced at best; the Curiosity Stop Signal
interplay decided for #95 applies once deterministic state exists. This extends ADR-0116 from
utterance-connected traits and values to any injected memory; ADR-0009's distinct attribution
language for Objective Memory still governs what may be claimed about user-stated facts.
