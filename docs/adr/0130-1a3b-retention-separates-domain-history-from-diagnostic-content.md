---
status: accepted
date: 2026-09-07
---

# 1A.3b retention separates domain history from diagnostic content

Successful EpisodeVersions are part of SayHear's versioned understanding of a real-world event, so their typed content and lineage remain until Internal Owner Full Purge. Reflection has no user-facing or authoritative historical value: its current committed version remains readable, a superseded committed version keeps content for 30 days, and draft, stale, failed, or otherwise uncommitted content keeps it for 7 days; after those deadlines only a content-free lineage envelope remains until Full Purge. Raw model request and response content for every 1A.3b role is diagnostic material rather than a second domain record and expires no later than 7 days, while allowlisted content-free command, attempt, policy, error, usage, and timing metadata follows its own bounded operational retention policy.

This deliberately accepts more long-lived private content for Episode history than for hidden AI observations. After Full Purge, allowlisted content-free access audit, security event, GenerationCommand, ModelRunAttempt, Workflow, Provider egress, and lifecycle-task metadata remains owner-associated during the single-owner phase and expires after 30 days; it must not be described as anonymous merely because direct IDs were removed. The latest Purge Marker and Deletion Receipts remain with the owner envelope because they prove active-system disposition and prevent backup resurrection. Source deletion and Full Purge remain stronger than every content grace period, and read-time deadlines prevent delayed sweepers or restored backups from extending access.
