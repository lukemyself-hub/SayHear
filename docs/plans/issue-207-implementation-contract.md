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

1. **G2 release domain (done, `7ab27f5`).** G2 role sets (6 enabled, 2-role
   bundle, Bio deferred), content-addressed G2 manifest build/verify with
   the 9 G2 acceptance criteria, Continuation 15-case calibration
   (8/5/2, strict-positive net preference, per-locale and protected
   categories non-negative, Luke-owned), and base-G1 linkage. Incomplete
   evidence stays blocked/pending by construction. Unit tests first (TDD)
   at this seam.
2. **G2 activation machinery without gate opening (2a, this layer).**
   Data `bindActiveG2Release` scoped to the 2-role bundle (requires the
   complete G1 pin set still active under the linked base-G1 fingerprint),
   `revokeActiveRolloutPins` generalized to also accept exactly the
   2-role bundle (G1 path behavior unchanged; suppression/use tables are
   never touched by pin revocation), web `SAYHEAR_1A_3B_G2_RELEASE_MANIFEST`
   resolution with G1-base linkage enforced at startup, and
   `release:g2:{build,verify,activate,rollback}` operator scripts. No new
   write switch, no registry/workflow/provider/egress change: every
   execution gate stays closed. Evidence-file re-hashing inside the
   scripts is deferred to layer 3 (no evidence files exist yet).
3. **G2 extract lane with shared runtime plumbing (2b, done 2026-09-15, uncommitted).**
   Explicit G2 write switches (`SAYHEAR_OPEN_LOOP_EXTRACTION_ENABLED`,
   `SAYHEAR_PROACTIVE_FOLLOWUP_ENABLED`, same explicit-switch
   discipline as G1), composition derives the active G2 regime only
   when the G2 manifest is active plus the G1 base switches plus both
   G2 switches (bundle never splits at runtime), registry built from
   the 6 G2 configurations, `verifyActiveG2Release` dispatch-time
   verification (G1 subset under the carried-over G1 fingerprint plus
   bundle under the G2 fingerprint plus stored base linkage), egress
   branching on the bundle roles, the `@sayhear/ai` extract provider
   (`{ proposals, closures }` single-object JSON mapping 1:1 onto the
   transient `OpenLoopProposal` / `OpenLoopClosureProposal` shapes;
   closure entailment is semantic per SPEC ch.6 so it comes from the
   same model call, never from keywords), the per-event extract runner
   plus scan service (admit goes through the shared model-role outbox
   into `model_role_requested`, mirroring episode admission), and the
   workflow-gate branch for `open_loop.extract`. `proactive.followup`
   stays gate-closed until 2c.
4. **G2 proactive lane (2c, deferred).** `proactive.followup` provider
   (segment generation, plus next-event disposition classification
   inside the same role so no other role's frozen contract is
   touched), the `ProactiveFollowupSegmentStage` implementation
   (prepare/generate/abandon over the existing reservation/segment/
   use repositories), harness wiring, and the workflow-gate branch
   for `proactive.followup`. Deferred as a separately reviewable
   layer, not as scope loss: the release bundle still merges at
   activation (layer 2a already enforces bundle atomicity).
5. **G2 evidence and drills (deferred).** Two complete expression configs
   through actual adapters/egress, Continuation 15-case Luke review,
   exact-manifest purge/restore and rollback drills with suppression/use
   preservation, hosted export scan. Deferred because these need real
   Provider credentials, a hosted deployment, and Luke adjudication, none
   of which are available to the agent.

## Layer 2a bound

- Production files: 2 (`postgres-model-role-command-repository.ts` in
  `packages/data`, `runtime-config.ts` in `apps/web`).
- Production TypeScript: about 275 lines (data ~190, web ~85).
- Architecture boundaries: 2 (data, web).
- Migration: no. G2 reuses the C1–C3 tables and the existing Purge Surface
  Registry; bundle egress-policy rows are evidence outputs inserted by
  layer-3 production, same as G1's `0053` precedent was for capture.
- Runtime/release wiring: persistence activation plus fail-closed manifest
  resolution only; no switch opens and no execution path changes.
- Operator tooling outside the bound (mirrors frozen G1 scripts, no
  execution-path effect): 4 new scripts (~430 lines), `package.json`
  entries, `.env.example` entry.
- Risk: MEDIUM, because `revokeActiveRolloutPins` validation is shared
  with the G1 rollback path; the G1 branch must stay byte-for-byte
  behavior-identical and is covered by the existing G1 system test.

## Layer 2b bound

- Production files: 9 (AI role providers; application open-loop
  runner; data open-loop + model-role-command repositories; web
  runtime-config, server-composition, model-role workflow,
  recovery-scanner handler, recovery-scan route).
- Production TypeScript: about 1100 lines (AI ~150, application ~380,
  data ~260, web ~310).
- Architecture boundaries: 3 (ai, application+data via existing
  package direction, web).
- Migration: no. New repository reads use existing C1 tables
  (conversation events/revisions, evidence items, daily sessions,
  open-loop lane); bundle egress-policy rows remain layer-3 evidence
  outputs.
- Release behavior: the G2 regime opens only with active G2 manifest
  plus G1 base switches plus both G2 switches; any missing piece
  falls back to the G1-or-empty registry exactly as before. No
  provider/model fallback (arch 15.3); extract keeps one same-model
  technical retry, matching its frozen role policy.
- Risk: MEDIUM-HIGH, because composition and egress now branch on the
  release stage; the G1 regime must stay behavior-identical and is
  covered by the existing G1 activation system test plus a G2-off
  composition fallback test.
- Test-seam consequence of the layer-2a fail-closed binding: system
  tests that admit/claim/record any role through a bare
  `PostgresModelRoleCommandRepository` now bind a synthetic stage
  fingerprint (G1 `d…` / G2 `e…`) with a matching pin
  `release_fingerprint` (lifecycle, model-role-command,
  narrative-validation, reflection-daily-weekly). New DB regression:
  `tests/system/open-loop-extraction-lane.system.test.ts` (scan →
  snapshot → admit → subject resolve → fake-provider extract →
  settled → scan converges, plus superseded-stale).

## Validation

- `pnpm exec vitest run packages/application/src/one-a-3b-g2-release.test.ts`
- `pnpm exec vitest run packages/application/src/one-a-3b-release.test.ts`
  (G1 regression)
- `pnpm typecheck`
- `pnpm check:boundaries`
- `pnpm check:purge-surfaces`

## Handoff (2026-09-15, branch `agent/issue-207`)

### Where things stand

- Layers 1, 2a, 2b are implemented; **nothing is committed** (working
  tree on top of `7ab27f5`, parent `main`). Do not commit/push without
  an explicit request.
- 2b verification, all green at handoff time:
  - Unit (DB-free): 1054 passed (`CI=true pnpm exec vitest run
    --exclude 'tests/system/**'`).
  - System (real Neon via gitignored `.env.neon`): 42 passed across 7
    files — g1/g2 release activation, open-loop lifecycle,
    model-role-command, narrative-validation, reflection-daily-weekly,
    and the new `tests/system/open-loop-extraction-lane.system.test.ts`.
  - `pnpm typecheck`, `pnpm check:boundaries`,
    `pnpm check:purge-surfaces` green.
- System-test invocation notes (Neon is remote and slow):
  - `.env.neon` cannot be `source`d (special characters); load it with a
    small Node dotenv-style loader and spawn vitest with the env.
  - Pass `--hookTimeout=300000 --testTimeout=300000` and
    `--maxWorkers=2`; 7 parallel files trip Neon contention and fail
    hooks (looks like code failure, is not).
- Two boundary violations were introduced and fixed mid-2b; the
  checker is a reliable gate, keep running it:
  - workflow files may only import `@sayhear/application` inside a
    step (dynamic `await import`), plus the `-contract` subpaths at
    top level — the lane policy constant rides the existing dynamic
    import in `runModelRoleStep`.
  - `packages/ai` (incl. tests) may not import `@sayhear/domain`;
    brand constructors come re-exported from `@sayhear/application`.

### Key design points the next agent must preserve

- Domain settlement keys on the frozen lane policy
  (`OPEN_LOOP_EXTRACTION_POLICY_VERSION`), not the role-envelope
  version from the outbox; the scan lists and the runner commits with
  the same constant, otherwise the settled-run dedupe join breaks.
- The model-role outbox subject is always the owner; the extract
  workflow resolves the Event revision via
  `readAttemptEventRevision` (generation-command row, role+owner
  fenced). No Event identity enters workflow payloads.
- `verifyActiveG2Release` requires the exact 6-role registry; the G2
  regime additionally requires the switched G1 underneath (composition
  gates on `activeG1ReleaseManifest`, not just a present G1 manifest).
- Layer-2a fail-closed binding stands: bare
  `PostgresModelRoleCommandRepository` admits/reclaims/records nothing;
  test seams bind synthetic fingerprints (G1 `d…`, G2 `e…`).
- Rollback semantics: after a G2 rollback, attempts fail loudly at
  bundle verification (never write); the operator rollback script owns
  switch/manifest flips. No composition change needed for this.

### Next work

1. **Layer 2c (proactive lane, no Luke input needed).** Mirror the 2b
   shape: `proactive.followup` provider in
   `packages/ai/src/one-a-3b-role-providers.ts` (segment generation +
   next-event disposition inside the same role),
   `ProactiveFollowupSegmentStage` prepare/generate/abandon over the
   existing reservation/segment/use repositories
   (`packages/data/src/postgres-proactive-followup-repository.ts`
   already exists), harness wiring, workflow-gate branch for
   `proactive.followup` next to the extract branch in
   `apps/web/src/workflows/model-role.workflow.ts`, scan/scheduler
   trigger, fake-provider unit + system tests. Suggested bound: same
   shape as 2b, no migration (C2 tables exist), MEDIUM-HIGH.
2. **Layer 3 (evidence and drills).** Blocked on Luke (see below).
3. Commit discipline: layers landed as one uncommitted tree; when Luke
   asks for commits, keep 2b (and later 2c) as separate reviewable
   commits on `agent/issue-207`, never rewrite `main` history.

### Needs Luke (blocking layer 3 only; 2c is unblocked)

- [ ] Real Provider credentials/egress approval for the two evaluated
      expression configs (actual adapters/egress run).
- [ ] Continuation 15-case review (8/5/2, strict-positive net
      preference, per-locale + protected categories non-negative) —
      Luke-owned adjudication per the G2 manifest calibration.
- [ ] Hosted deployment + `SAYHEAR_DEPLOYED_GIT_COMMIT_SHA` (or Vercel
      SHA) so the G2 manifest `gitCommit` check and the hosted export
      scan can run.
- [ ] Exact-manifest purge/restore and G2 rollback drills with
      suppression/use preservation sign-off.

### Suggested skills for the next agent

- `implement-by-layers` for layer 2c (dependency-ordered, reviewable
  layers with the fixed review budget).
- `tdd` for the provider/runner seams (validators and deterministic
  cores first, fakes in tests, no live calls).
- `diagnosing-bugs` if a system-test failure appears under Neon —
  first suspect hook/worker contention (rerun with `--maxWorkers=2`),
  then the fail-closed fingerprint binding, then real logic.
- `code-review-with-budget` before reporting 2c done (Standards =
  boundaries/workflow-transform rules, Spec = #207 AC + SPEC #193
  ch.6/7), two passes max.
- `create-github-issue` if any follow-up (e.g. G2-on composition pin
  without DB, currently covered only indirectly) should be tracked
  rather than fixed inline.
