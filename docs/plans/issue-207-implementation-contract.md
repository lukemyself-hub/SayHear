# Issue #207 implementation contract

## Goal

Freeze the Open Loop / Proactive follow-up bundle behind a single G2
release manifest with deterministic evidence. Layers 1–2c plus the v2
echo fix are implemented and committed (`1f6cb1c` on `agent/issue-207`);
remaining are the layer-3 human/hosted steps (15-case review, hosted
export scan, purge/rollback drills).

## Expected production change

- Cumulative committed state: layers 1 (release domain, `7ab27f5`),
  2a (activation), 2b (extract lane), 2c (proactive lane), v2 echo
  fix — one commit `1f6cb1c`, ~2750 insertions across 29 tracked
  files plus 16 new files (providers, stage, lane adapter, scripts,
  unit + system tests).
- Architecture boundaries: ai, application, data, web — all within
  the existing package direction; `pnpm check:boundaries` green.
- Migration: no. G2 reuses the C1–C3 tables and the existing Purge
  Surface Registry; no new data surface.
- Runtime wiring: present but gated — G2 write switches default
  closed; the G2 regime additionally requires the active G2 manifest
  plus the switched G1 base. No switch is open.
- Risk: MEDIUM-HIGH, carried by composition/egress branching on the
  release stage; the G1 regime stays behavior-identical and is
  covered by the G1 activation system test plus the G2-off
  composition fallback test.

## Bound exception (layer 1, historical)

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
3. **G2 extract lane with shared runtime plumbing (2b, done 2026-09-15, in `1f6cb1c`).**
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
4. **G2 proactive lane (2c, done 2026-09-15, in `1f6cb1c`).**
   `proactive.followup` provider (segment generation, plus next-event
   disposition classification inside the same role),
   `ProactiveFollowupSegmentStage` prepare/generate/abandon over the
   existing reservation/segment/use repositories, harness wiring via
   `apps/web/src/proactive-followup-lane.ts`, the workflow-gate crash-path
   branch (`abandonSegmentByCommand` + discard, no model call, no retry),
   and the recovery-scanner maintenance trigger
   (`reconcileTerminalReservationsGlobal`). Postgres readers for turn
   context, dialogue snapshot, lane watermark (`hasUnsettledExtraction`),
   formation lineage, and gated summaries; no migration.
5. **v2 echo fix (done 2026-09-15, in `1f6cb1c`, Luke-approved fix (a)).**
   deepseek-flash egress evidence showed v1 insufficient: the
   disposition prompt demanded echoing a locator the payload never
   supplied, and the segment prompt demanded echoing an identity never
   supplied as an object. The disposition request now carries
   `finalTextLocator`, the segment request carries `targetRef`, both
   prompts name the field, and the application validators check exact
   echo. `proactive-followup-prompt` and `proactive-followup-policy-bundle`
   v1 → v2 per SPEC §7.4; expression policy stays v1. Re-smoke on
   deepseek-flash: 4/4 full passes (segment + disposition, exact echo).
6. **G2 evidence and drills (open).** Continuation 15-case Luke review
   (ON-vs-OFF comparison on identical Memory input, NOT expression
   iteration — Luke decision 2026-09-15), exact-manifest purge/restore
   and rollback drills with suppression/use preservation, hosted
   export scan, evidence-file re-hashing inside the `release:g2`
   scripts (deferred from 2a: no evidence files exist yet).

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

## Layer 2c bound

- Production files: 6 (AI role providers; application
  proactive-followup provider/stage/types; data open-loop +
  proactive-followup repositories; web lane adapter,
  server-composition, model-role workflow, recovery-scanner
  handler + route).
- Architecture boundaries: 3 (ai, application+data via existing
  package direction, web); workflow files touch application only
  inside steps.
- Migration: no. New repository reads/writes stay on the C2 tables
  (reservations, uses, dispositions, segment commands); the two new
  crash-path methods are idempotent by construction.
- Release behavior: the segment generates in-request inside the turn
  harness; the durable workflow owns only the crash path
  (reclaim-then-discard, never retries per ADR-0132). Disposition
  failure leaves the use unsettled and the target closed
  (fail-closed, main response preserved).
- Risk: MEDIUM-HIGH, same shape as 2b (composition/egress branching);
  covered by fake-provider unit tests, two Neon system suites
  (crash path + readers, proactive seam), and real-egress smoke.
- Test-seam consequences: disposition/segment provider requests now
  carry `finalTextLocator` / `targetRef` (v2); fixtures constructing
  them were updated; `commitUse` fixtures pin prompt/bundle v2.

## Validation

- `CI=true pnpm exec vitest run --exclude 'tests/system/**'`
  (1084 unit tests, DB-free).
- Neon system suites (gitignored `.env.neon`, see handoff for
  invocation notes): proactive crash path + readers, proactive seam,
  open-loop extraction lane, open-loop lifecycle.
- `pnpm typecheck`, `pnpm check:boundaries`,
  `pnpm check:purge-surfaces`.
- Real-egress smoke (authorized): `createRuntimeOneA3bRoleProviders`
  with the DeepSeek adapter on `deepseek-flash`, synthetic frozen
  input, outputs asserted through the repo validators (temp script,
  deleted after the run; no writes, no switches touched).

## Extraction prompt v3 (2026-09-17, Luke-approved)

`open_loop.extract` on the pinned flash model returned
`{"proposals":[]}` for clearly loop-worthy utterances with a
body-dependent, time-varying probability (same zh text measured 0/8
vs 8/8 in one minute, differing only in evidence IDs). Identical
retries do not help; `reasoning.effort`, `seed`, model name, and a
`deepseek-v4-pro` swap were all measured. The prompt's negative bias
("Never propose ... unfinished topics") made the model read
"我在等…" as an unfinished topic.

Fix (v3): one positive decision rule added to the
`open_loop.extract` instruction in
`packages/ai/src/one-a-3b-role-providers.ts` — "Emit a proposal
whenever the utterance mentions a future scheduled event or an
outcome the user is waiting to hear about, even if it seems minor;
use an empty proposals array only when the utterance contains no
future happening at all."

Measured with the pinned provider (5 samples per utterance):

- zh loop utterances: 0/5 before, 5/5 after (three separate texts).
- `My medical exam results come out next Monday.`: 4/5 -> 5/5.
- `My lease renewal signing is on September 28th.`: stays
  `isTaskLike: true` (a dated obligation), i.e. precision kept.
- Correct-zero controls (direct task, high-risk distress, dinner
  question, tired small talk): 0 formable proposals, 3/3 each.

Pins bumped: `open-loop-extract:eval:v3` /
`open-loop-extract:v3` in `eval/continuation-acceptance-1a3b/pins-v2.json`.

Two further findings from the same investigation, both fixture-side:

1. A proposal that claims a precise window from a digit-free fuzzy
   expression is rejected by the frozen near-term allowlist
   (`planOpenLoopFormation` -> `no_real_anchor`, SPEC 6.2). Fixture
   utterances now use explicit calendar dates (digits) or allowlisted
   near-term phrases; admission code was not changed.
2. Open Loops expire at `windowEnd + 14 days` (unanchored:
   `committedAt + 14 days`), so the old `clockAdvanceDays: 14` review
   turn sat exactly on the expiry boundary and the lane filtered the
   loop. Fixture advances are now 10 days.

With those, two independent full ON captures formed 10/10 declared
loops and passed `verify-g2-treatment.ts` with 0 failures / 28 eligible
scenes.

## Handoff (2026-09-15, branch `agent/issue-207`, committed `1f6cb1c`)

### Where things stand

- Layers 1, 2a, 2b, 2c, and the v2 echo fix are implemented and
  committed. Working tree is clean (only gitignored worktree
  scaffolding untracked). Do not push or rewrite history without an
  explicit request.
- Verification at commit time, all green (see Validation above):
  1084 unit tests; Neon system suites for the lanes; typecheck,
  boundaries, purge-surfaces.
- Real-egress evidence (deepseek-flash, authorized run 2026-09-15):
  v1 segment sufficient, v1 disposition insufficient (locator never
  supplied); v2 supplies both echo objects and passes 4/4 full runs.
  Raw outputs were reported to Luke; the temp script was deleted.
- System-test invocation notes (Neon is remote and slow):
  - `.env.neon` cannot be `source`d (special characters); export
    single vars instead, e.g.
    `export TEST_DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env.neon | cut -d= -f2-)"`.
  - Prefer `--maxWorkers=2`; 7 parallel files trip Neon contention
    and fail hooks (looks like code failure, is not).
  - Slow suites need raised hook budgets (`beforeAll(..., 120_000)`
    pattern in `tests/system/proactive-followup-crash-path.system.test.ts`).
  - node-pg deduces each placeholder independently: never reuse one
    `$n` in conflicting type positions (e.g. uuid column + text
    concat); use a separate placeholder per context.
  - DeepSeek snapshot guard: `modelSnapshot` must equal the served
    model id (`deepseek-flash`), or the provider rejects its own call.
- Known pre-existing environment flake (not caused by this stack,
  file untouched): `tests/system/g2-release-activation.system.test.ts`
  runs full migrations in `beforeEach` and exceeds the 10s hook
  budget on cold Neon; passes intermittently on retry.

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

1. **Layer 3 remainder (evidence and drills).** Blocked on Luke (see
   below): 15-case ON-vs-OFF review on v2, exact-manifest
   purge/restore and rollback drills, hosted export scan,
   evidence-file re-hashing in the `release:g2` scripts.
2. Commit discipline: the stack landed as one commit `1f6cb1c` per
   Luke's request; keep layer-3 work as separate reviewable commits
   on `agent/issue-207`, never rewrite `main` history.

### Needs Luke (blocking layer 3 only; implementation is done)

- [x] Real Provider credentials/egress approval — DeepSeek key
  available; authorized smoke completed (v1 verdict + v2 4/4).
- [x] v1-sufficiency decision — v1 insufficient (disposition);
  fix approved (option a); prompt + bundle now v2.
- [x] Evaluation framing — same model `deepseek-flash` both sides;
  goal is ON-vs-OFF conversation comparison, not expression
  iteration.
- [ ] Continuation 15-case review (8/5/2, strict-positive net
      preference, per-locale + protected categories non-negative) —
      Luke-owned cases + adjudication per the G2 manifest calibration.
- [ ] Hosted deployment + `SAYHEAR_DEPLOYED_GIT_COMMIT_SHA` (or Vercel
      SHA) so the G2 manifest `gitCommit` check and the hosted export
      scan can run.
- [ ] Exact-manifest purge/restore and G2 rollback drills with
      suppression/use preservation sign-off.

### Suggested skills for the next agent

- `research` for layer-3 legwork that needs primary sources (hosted
  export-scan behavior, DeepSeek model-identity changes) — capture
  findings as a repo file, not chat text.
- `diagnosing-bugs` if a system-test failure appears under Neon —
  first suspect hook/worker contention (rerun with `--maxWorkers=2`),
  then cold-start hook budgets, then the fail-closed fingerprint
  binding, then real logic.
- `code-review-with-budget` before reporting layer 3 done (Standards =
  boundaries/workflow-transform rules, Spec = #207 AC + SPEC #193
  ch.6/7), two passes max.
- `create-github-issue` for follow-ups that should be tracked, not
  fixed inline (e.g. the `g2-release-activation` hook-budget flake;
  exchange-mention detection, currently a documented `false` default
  in `apps/web/src/proactive-followup-lane.ts`, needs a dedicated
  mention pipeline).

## Evaluation scene rework and v2 review package (2026-09-18, Luke-approved)

Grilling round with Luke settled the human-review design (Q1–Q11); the
review surface, sample composition, and eligibility rules below replace the
stale versions in `issue-207-g2-evaluation-redesign-plan.md` sections
"Track C", "Capture eligibility gate", "Sampling and blinding", and "HTML
requirements".

### Settled decisions

- This round compares ON vs OFF only. ADR-0136 is amended: bounded
  exception binds `proactive-expression-v2` as the sole verified
  configuration; no expression-style review is planned for now.
- Human sample admits Review-Worthy Scenes only: both arms differ on a
  Backend-Decision Product (ON-only committed segment), the quality needs
  human judgment, and the product is visible in the transcript or Context
  Panel. Correct-zero scenes are Contract-Only and no longer occupy human
  slots (`high_risk` coverage moves to deterministic gates; `refusal`,
  `short_answers`, `topic_change`, `direct_task` stay forced).
- Review surface = both transcripts plus a neutral, arm-blind Context
  Panel (shared pre-case knowledge: seeded Memory Claims / Portrait; no
  arm labels, no fixture description, no scenarioId, no coverage tags).
  Assessment point lives only in the rating instructions.
- Sample = 15 scenes, 8 en / 5 zh / 2 code-switch, family minimums
  >=4 open loop, >=4 memory, >=3 stateful, >=2 competing, topic cap <=3,
  protected coverage as above.
- Tie ceiling: if more than 1/3 of scene-level verdicts tie, redesign the
  offending scenes before delivering again; ties never count for a side.
- Scene texts: all 16 scenes whose reviewed segment was generic had their
  reviewed turn rewritten to a calm, information-thin turn so the declared
  target is the only salient object; capture conditioning only retries
  extraction on turns the fixture declares as a loop source (one honest
  attempt elsewhere). Full main (68 responses / 28 scenes), OFF (28), and
  ON (28) recaptures were rerun.

### Results and artifacts

- `verify-g2-treatment.ts`: passed, failureCount 0, 28/28 eligible;
  extraction attempts fell 496 -> 67.
- Official artifacts: `run-v2/continuation-main.json`,
  `continuation-off.json`, `continuation-on.json`, `treatment-ledger.json`,
  `run-v2/expression-selection.json` (waiver record), pins
  `expression.selectedConfigId = proactive-expression-v2`.
- Review package v2: `build-review-package-v2.ts` ->
  `run-v2/review/` (pairs.json, sealed-identities.json, scores.json,
  review-package.json, index.html). Sample seed 207, fixture seed 207,
  A/B 7/8, no description or target-identity leakage.
- Verifier addition: a scene whose fixtures declare no `open_loop`
  target must form zero loops; the two `competing * loop-vs-memory`
  scenes were relabeled: their fuzzy mentions correctly fail the
  admission fence and the memory claim is cited instead.
- Accepted imperfection: `g2-open-loop-en-dissertation` forms two loops
  from its turn-1 event internally; the verifier still pins the declared
  ordinal-0 target and the extra one never reaches the reviewer.

### Needs Luke (this round)

- [ ] Blind review of `run-v2/review/index.html` (A/tie/B per turn and
      per scene). If ties exceed 5 of 15 scenes, scenes are redesigned
      before delivery.
- [ ] After review: unblind, then construct the G2 manifest calibration
      with the 15-case sample and the full-pool hard gates.

## v2 human-review failure and v3 iteration (2026-09-20)

- Luke's completed v2 review preferred ON in 3 scenes and OFF in 12, with no
  ties. Overall net preference was -9; English, Chinese, refusal,
  topic-change, and direct-task slices regressed. No release calibration was
  produced.
- The downloaded score export is preserved byte-for-byte under
  `run-v2/review/scores.json`; `failed-review.json` records its hash and the
  observed `scoredAt` discrepancy without pretending v2 exported a package
  fingerprint.
- Root cause: the v2 schema required a non-empty question or acknowledgment,
  and the fallback prompt forced generic care when no appropriate expression
  existed. Structural target-ref validation could not reject semantic
  duplication, dangling references, identity confusion, or bad timing.
- Luke approved a v3 candidate iteration. It keeps ADR-0044's isolated optional
  segment, but allows a successful typed omission that releases the
  reservation, commits no use, and leaves the main response unchanged.
- The new review package must use new capture paths and seeds, expose neutral
  current-date/elapsed-time context, bind score exports to a package
  fingerprint, and never overwrite run-v2 evidence.
- Stateful suppression fixtures are conditional under the v3 schema: when the
  initial selected opportunity emits, the existing disposition and suppression
  assertions remain mandatory; when it returns a valid typed omission, the
  reservation-release/no-use assertions are mandatory and downstream
  suppression checkpoints are not applicable because no prompt was shown.

## v3 preflight failure and v4 dual-track acceptance (2026-09-23)

The run-v3 full pool is frozen as preflight evidence, not a final human-review
package: 34 expression decisions yielded 4 committed emits and 30 typed
omissions; 11 of the 15 sampled scenes had identical ON/OFF responses. Its
eligibility and package builder therefore do not satisfy the accepted G2 review
contract. Keep all run-v2 and run-v3 files unchanged.

### Review protocol

- `blind-pairwise:g2-v4` samples exactly 15 actual committed emits (8 English,
  5 Chinese, 2 code-switch). Every scene must show a visible ON-only treatment
  difference; typed omissions and identical outcomes cannot fill a pairwise slot.
- Pairwise quality is judged per differing turn and per complete scene with
  A / tie / B. Shared transcript history is shown once, locale and protected
  slices may not regress, candidate net preference must be strictly positive,
  and ties may not exceed 5 of 15 scenes.
- A separate 8-case omission audit includes actual typed omissions spanning
  the four reasons, Memory / Open Loop, and all locale forms. Its only choices
  are `沉默合适`, `本应跟进`, and `无法判断`; it passes with zero in the latter
  two categories. Omission reason and expected outcome stay operator-only.
- `correct_zero` remains covered by deterministic gates; it is not an omission
  audit case because it has no selected target and must not call the expression
  provider.

### v4 evidence boundary

The v4 evaluator has independent fixture, pin, protocol, and evidence paths.
Pairwise sampling and positive coverage count actual committed emits only;
stateful coverage requires observed use / disposition / suppression transitions.
The verifier requires exact scenario and turn sets, recomputed fingerprints,
frozen main response equality, reservation/use/disposition invariants, and a
clean committed evaluator revision. It records both exact-byte `rawSha256` and
canonical JSON hashes. The package, score, and unblinder versions are
`1a3b-g2-review-package:v4`, `1a3b-g2-scores:v4`, and
`blind-pairwise:g2-v4`. Reviewer payload and operator identity mapping are
stored in physically separate directories; score export binds the exact public
package fingerprint. Unblinding first verifies that fingerprint.

The v4 capture uses one frozen seed and at most one semantic result per
predeclared turn. Insufficient gates are a frozen failure; no semantic reruns,
seed changes, scene deletion, or omission substitution are allowed.

## v5 precision-first acceptance (2026-09-23)

The full-pool v4 capture remains immutable failed evidence. v5 retains the
production behavior that the main response is independent and its ordinary
question suppresses the G2 stage. A typed `omit` is valid; the expression
provider is not semantically retried.

### Review gates

- Pairwise uses exactly 10 actual committed emits: 5 English, 3 Chinese, 2
  code-switch. The sample includes at least 3 Memory, 3 Open Loop, 2 complete
  stateful trajectories, and 1 competing-pool scene; one remaining case is
  selected by the frozen seed. A/B positions are balanced 5/5.
- Refusal, short-answer, topic-change, and direct-task protected categories
  appear in sampled scenes with a visible treatment difference.
- Candidate scene-level net preference is strictly positive, no locale or
  protected slice regresses, and no more than 3 of 10 scene decisions are ties.
- The separate omission audit uses 8 actual typed omissions, two per reason,
  across Memory / Open Loop and English / Chinese / code-switch. `本应跟进`
  and `无法判断` must both be zero.
- Emit recall is at least 30% over predeclared opportunities whose frozen main
  has no ordinary question and whose current opportunity, lanes, and expected
  eligible target pass deterministic selection. Selection mismatch is a hard
  failure and cannot be removed from the denominator. Report the complete
  positive-scene funnel as well.

### Evidence and bounded supplementation

The capture ledger distinguishes `not_reached`, typed `omitted`, `committed`,
and `failed`. Only a Provider-returned typed omit with released reservation is
an omission audit outcome. Correct-zero checks provider calls and state changes,
not the absence label used when the stage was never reached. Scene-level
competitors participate in target-pool verification, and an ordinary-question
skip does not masquerade as a missing candidate pool.

Development calibration uses disjoint synthetic scenes. After calibration,
the complete formal catalog, pins, seed, and at most three capture batches are
pre-registered and hashed before the first Provider call. Every turn receives
one semantic result. A later batch may run only when all observed hard gates
pass and the current pool lacks a language or family sample quota. All batches
remain in the full-pool verifier input. A recall failure freezes the round;
it cannot trigger supplementation. v5 artifacts use new schema and evidence
paths, and no v4 result is rewritten or reused.
