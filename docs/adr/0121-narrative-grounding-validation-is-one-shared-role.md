---
status: accepted
date: 2026-09-04
---

# Narrative Grounding Validation Is One Shared Role

Daily / Weekly Reflection and Bio validate their grounding with
the same method — atomic-proposition decomposition, support / contradiction
entailment, and source-to-output coverage — established by the 1A.3b grounding
research (#165). 1A.3b therefore defines one shared grounding-validator model
role, `narrative.validate`, used by both Reflection and Bio generation
commands, instead of per-artifact validator roles. Each GenerationCommand
freezes the artifact-kind-specific Prompt, Schema, and validation policy
versions, so the two artifact kinds never silently share prompt semantics;
only the role, model routing, and calibration evidence are shared.

Sharing exists for calibration, not convenience. A single bilingual gold set
and false-positive ledger qualify the validator once, and a verdict class can
be promoted from advisory to blocking only with evidence that applies to both
artifacts. Per-artifact validator roles would let two calibration programs
drift independently and double the review surface for the same error classes.
The coupling is deliberate: splitting the role later requires re-qualifying
whichever side keeps it, through a new ADR.
