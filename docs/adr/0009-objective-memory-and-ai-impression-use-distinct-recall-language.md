---
status: accepted
date: 2026-07-25
---

# Objective Memory and AI Impression use distinct recall language

SayHear must preserve a Memory Claim's kind and epistemic status in user-facing recall language. Objective Memory may be attributed to what the user previously said, without implying independent verification. AI Impression must remain an observation rather than being upgraded into a user-stated or verified fact; under ADR-0116 it may use natural relational language without a mandatory provenance preamble or ritual hedge. It still cannot be recalled as “I remember that you are...” when that wording presents the inference as settled fact.

This makes the boundary between user statements and SayHear's interpretation visible during normal conversation, not only after a user challenges a memory. Recall projection and behavior validation must therefore reject output whose framing upgrades an AI Impression into an Objective Memory or verified fact.

ADR-0116 amends the expression mechanism: an AI Impression may use natural relational observation
without a mandatory provenance preamble or ritual hedge. The typed epistemic boundary and the ban
on upgrading an Impression into a user-stated or verified fact remain unchanged.
