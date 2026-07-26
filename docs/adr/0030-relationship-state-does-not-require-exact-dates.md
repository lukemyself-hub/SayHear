---
status: accepted
date: 2026-07-26
---

# Relationship state does not require exact dates

A Relationship Memory Claim records whether the relationship is `current`,
`ended`, or `unknown` independently from whether its start and end dates are
known. `valid_from` and `valid_to` may be absent, and each bound retains an
`exact`, `month`, `year`, `approximate`, or `unknown` precision. Evidence time,
Claim creation time, `last_observed_at`, and real-world assumptions never fill
missing relationship dates.

SayHear can therefore represent “she is my mother” as current with an unknown
start, and “he used to be my colleague” as ended with an unknown end. An ended
relationship may project “former” resolver language without an exact
`valid_to`; an unknown state cannot project assertive current or former terms.
This adds temporal states and precision-aware queries but preserves a truthful
life timeline instead of manufacturing exact dates.
