---
status: accepted
date: 2026-09-07
---

# 1A.3b model roles fail independently

1A.3b uses seven independently pinned model roles: `episode.build`,
`open_loop.extract`, `reflection.daily`, `reflection.weekly`, `bio.write`,
`narrative.validate`, and `proactive.followup`. A model may win evaluation for
more than one role, but each role keeps its own Prompt, Schema, policy, model
configuration, failure state, and rollback pin. Open Loop extraction does not
share `memory.extract`, and proactive expression does not inherit the
`conversation.text` configuration.

This deliberately spends additional Provider calls to keep failures and
upgrades local. 1A.3b does not enable cross-model or cross-Provider fallback.
If `narrative.validate` does not complete, a Reflection may remain a draft but
cannot become current or propose Memory Candidates; an older current version
is retained only while its own source and lifecycle fences remain valid.

`episode.build`, `open_loop.extract`, both Reflection roles, `bio.write`, and
`narrative.validate` may retry a timeout, 429, 5xx, or result-unknown failure
once with the same frozen model configuration. `proactive.followup` never
retries: failure or expiry omits the segment and preserves the main response.
Authentication, configuration, incompatible Schema, deterministic business
fence, stale source, and Data Epoch failures never retry. Semantic rejection
uses each role's domain outcome rather than being relabeled as a technical
failure.
