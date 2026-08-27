# Predicate Registry v1 — frozen-model replay & pre-release human review

This directory owns the ADR-0061 replay discipline for the Predicate Registry
(grilling #93 §8, SPEC #107 AC 8). It exists so that **no registry release
merges on machine gates alone**: a human reviews the full mapping behavior of
the exact artifact before it ships. There is no LLM judge anywhere in this
flow — every gate verdict is deterministic.

## What the replay runs

`replay.mts` re-executes the authoritative corpus from
[`packages/application/src/predicate-registry/mapping-eval-corpus.ts`](../../packages/application/src/predicate-registry/mapping-eval-corpus.ts)
— the same forward (≥2 positive examples per predicate × zh / en / code-switch,
asserted down to predicate ID + normalized typed value + direction) and reverse
zero-tolerance cases (confusable separation, closure-language no-claim,
deferred concepts → unmapped + proposal, unknown concepts → unmapped, illegal
values fail closed, replay determinism) that `pnpm test` gates in CI today.

## Running it

```bash
pnpm tsx eval/predicate-registry-v1/replay.mts            # deterministic mapper
pnpm tsx eval/predicate-registry-v1/replay.mts --out dir  # custom output dir
```

Artifacts land in `run/<utc-stamp>/findings.json`: totals, per-case status,
the release-pinning SHA-256 `registryFingerprint`, and an empty
`humanReview` block awaiting sign-off.

## Pre-release human review protocol (required before merge)

1. Run the replay with the mapper you intend to release (`deterministic`
   today; a candidate model role once `memory.extract` exists — wire it into
   `MAPPER_IMPLEMENTATIONS` in `replay.mts`, no other file changes).
2. Confirm `totals.failed === 0`. Failures mean: stop.
3. Open `findings.json`; set `humanReview.reviewer`, `reviewedAt`, and
   `verdict` to `approved` (or `rejected` with notes), then commit the run
   directory alongside the release so the reviewed fingerprint travels with
   history.
4. Merge only if the committed `registryFingerprint` equals the fingerprint of
   the snapshot being released — `predicateRegistryFingerprint(
   loadPredicateRegistrySnapshot(1))` is the arbiter; any content byte change
   invalidates prior approvals by design (ADR-0074 lineage discipline).

## Model-comparison replays (future)

Per ADR-0061 there is no formal promotion gate: when a Challenger extraction
model is judged against this corpus, replay both configurations, eyeball the
two findings manifests plus sampled diffs, and record the developer decision
in the ticket. Frozen input, frozen registry version, explicit comparison —
nothing shadowed, nothing written back to product state (ADR-0071/0073).
