---
status: accepted
date: 2026-08-22
---

# Persona safety posture is session-scoped and releases by clean turns

Supersedes ADR-0109. ADR-0109 required the post-signal Persona deference to persist until a versioned release criterion was met, and forbade release by fixed turn counts or timers. In practice that forces one of two failures: the deference outlives its meaning indefinitely, or release quietly depends on the user explicitly saying they are safe — which users do not know they are supposed to say. This ADR keeps deference from being a one-turn costume while fixing both.

Safety Posture is a deterministic domain state on the Daily Session, not a DialogueState field and not model state. Activation comes from versioned deterministic detection of an explicit self-harm, harm-to-others, or imminent-danger signal. The posture survives Continuous Exchange boundaries within the day and does not survive the day: a new session starts in the default state, and any new signal re-activates it.

Release is automatic: after K consecutive user turns with no renewed high-risk signal, the posture clears. K is a versioned parameter, initially 2 — a single clean turn would reproduce the recorded baseline failure of losing the real-world-support anchor at turn two. An explicit user statement of safety counts as one clean turn and does not short-circuit; a renewed signal resets the count. Neither timers nor model preference participate in release.

Enforcement is compilation, not discretion: while the posture is active, the Context Compiler renders the reduced persona variant (pausing Playful Warmth, ordinary Selective Curiosity, outward emotional self-reference, and non-essential opinions; warmth, care, and directness stay), and responses keep a real-world support anchor with whitelisted numbers. A failed detector activates no new posture, holds any active one, and alerts; the prompt-layer Minimum High-Risk Response remains the fallback. Consequences: CONTEXT.md's Persona Safety Deference entry is rewritten, and the behavior contract's trajectory criterion now expects the anchor on exactly the posture-active turns.
