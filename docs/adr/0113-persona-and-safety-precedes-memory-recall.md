---
status: accepted
date: 2026-08-22
---

# Persona and Safety precedes Memory Recall in delivery order

Issue #65 asks what staged route turns the resolved Persona (#67), behavior (#63), Context-engineering and safety (#64) decisions into executable SPECs. Implementation stands at Core Flow 1A.2 plus the private-data release gate, with a thin one-line persona, no Safety Posture, and a pre-0111 DialogueState projection; the architecture ladder's next stages were 1A.3 (Entity and long-term Memory) and 1A.4 (Replay).

The delivery ladder becomes Foundation, 1A.1, 1A.2, **1A.2P Persona & Safety**, **1A.3a Memory & Recall**, **1A.3b Continuation & Reflection**, 1A.4, 1B.1, 1B.2. "1A.3" remains valid as the collective name of the 1A.3a / 1A.3b pair where the distinction does not matter; existing 1A.4+ numbering is untouched.

**1A.2P** lands every ADR-0111 / ADR-0112 input that does not depend on memory: the three-block persona artifact with first-version canonical Persona and locale-pack prose, per-GenerationCommand-stage task instruction, Safety Posture with deterministic detection and K=2 clean-turn release plus the reduced persona variant, the session-scoped Curiosity Stop Signal projection, the six semantic DialogueState fields as a clean v2 (old fields dropped, no backfill, no batch rewrite of historical outputs), a single versioned safety-resource whitelist shared by production anchor rendering and the behavior contract's hard gates, scenario-pack fixtures updated to the new posture rules, and the read-only Context Inspector. Cutover for the Internal Owner is a direct switch with strategy versions pinned in CompiledContext; rollback is re-pinning prior versions — no feature flags, no dual-run.

**Strict sequencing**: no 1A.3a implementation starts until 1A.2P has landed and frozen a new baseline. The reason is single-variable attribution — the #62 policy ladder validated the method, and landing persona and memory together would make improvement unattributable; Person Portrait also compiles on top of the persona artifact structure. Internal Core's single-owner usage carries no pressure to parallelize.

**Why 1A.3 splits**: cross-day recall in conversation is the validated value driver (#62's memory-aware policy won on recall and time grounding); Episode, Open Loop, Proactive Follow-up, Reflection, Profile Projection, and the predicate-registry governance flow are separable and riskier. 1A.3a therefore carries Entity, Claim admission, relationship Claims, retrieval with versioned budgets v1 and per-item fences, Person Portrait compilation, memory-fixture judgment going live, the injected-evidence-only grounding guard, and the Memory Correction / Forget / Source Explanation actions — fences must be exercisable from the first recallable Claim, and #62 found recall overreach. 1A.3b carries the rest.

**Comparison order** after 1A.2P: persona strategy version, then register / locale polish, then champion model change — all evidenced on the synthetic scenario pack (no private data). The formal Replay harness and Model Routing Policy stay at 1A.4; champion changes remain developer-judged (ADR-0061), not stage-gated.

**1A.2P acceptance**: the behavior contract's three evidence items, plus at least one of the 生命力 / 温暖关心 taste medians strictly better than the frozen #61 baseline in blind pairwise — otherwise iterate before merge. The #61 thin-persona run stays the permanent pre-reform baseline; the frozen run after 1A.2P merges becomes the incumbent baseline for 1A.3a comparisons.
