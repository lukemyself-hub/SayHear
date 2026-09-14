# Issue #207 implementation contract

## Goal

Freeze the Open Loop / Proactive follow-up bundle behind a single G2
release manifest with deterministic evidence, leaving actual Provider,
hosted, and human steps explicitly pending instead of claimed.

## Expected production change

- Production files: 3 (`model-role-contract.ts`, `one-a-3b-g2-release.ts`,
  `index.ts` in `packages/application`).
- Production TypeScript: about 1340 lines (45 edited + ~1295 new);
  tests and this contract are not counted in the bound.
- Architecture boundaries: 1 — application release/rollout domain.
- Migration: no. G2 reuses the C1–C3 tables and the existing Purge Surface
  Registry; no new data surface.
- Runtime/release wiring: no. Stage gates stay closed; gate opening,
  persistence activation, and operator scripts are deferred layers.
- Risk: MEDIUM, because rollout-gate code must not weaken the G1 contract
  or let unexecuted Provider/hosted/human evidence read as a pass.

## Bound exception

The 600-LOC production-diff bound is exceeded (~1340 lines). The excess
is the G2 structural verifier (~470 lines) plus the stage-specific
manifest skeleton, both required for parity with the accepted G1 release
machinery (`one-a-3b-release.ts`, 1274 lines). This layer genuinely cannot
be split further: shipping build without verify would produce manifests
that no verifier can check before a runtime switch, and sharing code by
rewriting the frozen G1 module would widen the blast radius onto accepted
G1 evidence machinery. File count (3), boundary count (1), migration
(none), and runtime-wiring (none) all stay within their bounds.

## Implementation layers

1. **G2 release domain (this layer).** G2 role sets (6 enabled, 2-role
   bundle, Bio deferred), content-addressed G2 manifest build/verify with
   the 9 G2 acceptance criteria, Continuation 15-case calibration
   (8/5/2, strict-positive net preference, per-locale and protected
   categories non-negative, Luke-owned), and base-G1 linkage. Incomplete
   evidence stays blocked/pending by construction. Unit tests first (TDD)
   at this seam.
2. **G2 activation and runtime wiring (deferred).** Data `bindActiveG2Release`
   scoped to the 2-role bundle, web manifest resolution, workflow-gate
   extension, and AI providers/egress for `open_loop.extract` plus
   `proactive.followup`. Deferred because opening gates without providers,
   drills, and real credentials would half-open the stage.
3. **G2 evidence and drills (deferred).** Two complete expression configs
   through actual adapters/egress, Continuation 15-case Luke review,
   exact-manifest purge/restore and rollback drills with suppression/use
   preservation, hosted export scan. Deferred because these need real
   Provider credentials, a hosted deployment, and Luke adjudication, none
   of which are available to the agent.

## Validation

- `pnpm exec vitest run packages/application/src/one-a-3b-g2-release.test.ts`
- `pnpm exec vitest run packages/application/src/one-a-3b-release.test.ts`
  (G1 regression)
- `pnpm typecheck`
- `pnpm check:boundaries`
- `pnpm check:purge-surfaces`
