---
status: accepted
date: 2026-09-06
---

# Bio Trust Rebuilds Preempt Ordinary Refreshes

A trust-boundary transaction hides the current Bio, advances `bio_source_revision`, and creates an idempotent trust rebuild intent before asynchronous work begins. Manual and weekly triggers that freeze the same source revision reuse one generation command and retain both trigger records; commands for older revisions may finish as history but cannot publish. An ordinary command never satisfies a trust rebuild. The read path independently checks owner scope, data epoch, current pointer, BioVersion readability, and every narrative-support ClaimVersion fence; an invalid support blocks the response and idempotently repairs the missing rebuild intent.

`building` and `trust_rebuilding` may use the same user-facing copy, because neither has a readable Bio. They remain distinct internal states: ordinary building may end in `generation_unavailable`, while trust rebuilding bypasses refresh limits and may end only in a fail-closed `trust_unavailable` state that cannot restore the invalidated BioVersion.
