---
status: superseded by ADR-0143
date: 2026-09-07
---

# Narrative validator acceptance weights Bio

The first `narrative.validate` acceptance set contains exactly eighteen fixed,
replayable cases: four Bio and two Reflection cases in each of Chinese,
English, and code-switched use, for twelve Bio and six Reflection cases total.
Every artifact and locale pairing is represented, and the set exercises every
known blocking class: unsupported content, contradiction, epistemic-kind
upgrade, material absence, manifest mismatch, and ambiguity.

Bio receives the larger share because it is user-visible and carries more
publication failure classes. These cases qualify dangerous-error detection;
they do not double as the separate fifteen-scenario blind evaluation of Bio
narrative naturalness, and results from the two evidence groups cannot offset
one another.

ADR-0139 defines the release threshold for this set: all eighteen cases require
human adjudication, one calibration miss is within the ten-percent recall
budget, and the separate precision gate permits no false blocks.
