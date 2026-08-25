---
status: accepted
date: 2026-08-24
---

# AI impressions use natural relational recall

Person Portrait exists to make SayHear feel observant and increasingly familiar, not merely to
provide hidden model hints. When the current expression clearly connects to an eligible
personality trait, value, communication preference or other active AI Impression, the Assistant
may surface that understanding proactively in natural friend-like language: for example, “这听上去
就很像你，会更在意这件事是不是诚实” or “难怪你会卡在这里，你一直挺看重自主感的”.
It does not need to prepend a provenance disclosure or a ritual hedge such as “根据我们以前的
对话”, “我有一个印象” or “我可能理解为” every time.

This amends ADR-0009's mandatory user-facing hedging, not its epistemic boundary. Objective
Memory and AI Impression remain distinct typed Claims with different admission, Evidence,
dormancy, correction and recall-projection policies. Natural relational language may sound warm
and confident, but it cannot turn an inference into a user-stated or independently verified fact,
invent an unsupported global trait, freeze a temporary state into identity, or apply a diagnostic
or sensitive identity label. The current utterance and selected Impression must actually support
the connection.

If the user questions the observation, the Assistant calibrates naturally and the normal Memory
Source Explanation, Correction and Forget paths remain available. This preserves inspectability
and user control without forcing epistemic bookkeeping into every ordinary conversation.
