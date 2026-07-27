---
status: accepted
date: 2026-07-26
---

# Episodes require real-world event anchors

An Episode is an optional, versioned life-event grouping supported by User
Evidence and a concrete real-world event anchor, such as one trip, move, or
project phase. Conversation, Daily Session, topic, place words, and emotion do
not create Episodes by themselves. A model may propose an Episode Candidate,
but code creates or continues an Episode only when Evidence-backed temporal
and Entity anchors safely identify the occurrence. A repeated place or topic
defaults to a separate event when Evidence shows a new occurrence; ambiguous
continuity remains unresolved rather than merged. Missing Episode enrichment
never blocks the response, Journal, or basic Memory Claim. This accepts missed
cross-day links in exchange for avoiding false life-event narratives.
