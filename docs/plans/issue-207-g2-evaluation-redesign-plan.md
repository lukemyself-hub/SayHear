# Issue #207 G2 ON-vs-OFF evaluation redesign plan

## Status

Proposed for implementation. This document is a working plan, not release evidence.

## Goal

Replace the invalid first G2 Continuation review with a causally attributable,
fail-closed evaluation of the complete Open Loop / Proactive Memory Follow-up
bundle.

The new review must let Luke judge only user-visible experience. Deterministic
tests and capture evidence must prove formation, lane completeness, selection,
suppression, reservation, typed use, latency behavior, and provenance before the
HTML can be built.

Keep the accepted AC-X01 contract unchanged:

- 15 blind pairwise calibration cases;
- 8 English, 5 Chinese, 2 code-switch;
- candidate scenario-level net preference strictly positive;
- no per-locale regression;
- no protected-category regression;
- full-pool deterministic hard gates remain independent and zero-tolerance where
  the current contract says so.

Do not reuse the failed package's scores, sealed identities, sample seed, or
review-package fingerprint.

## Why the first review is invalid

The first package must remain in the repository as failed audit evidence. Do not
overwrite or reinterpret it.

Confirmed facts:

- `eval/continuation-acceptance-1a3b/run/continuation-candidate-lanes.json`
  records zero formed Open Loops and zero committed proactive segments in all 18
  fixtures.
- The production proactive stage hard-disables the Memory lane at
  `packages/application/src/proactive-followup/stage.ts`.
- Both arms independently generated `conversation.text` responses. With no G2
  segment, the reviewed differences were ordinary model sampling differences.
- All Continuation fixtures had one turn. A one-turn transcript cannot show
  target-bound disposition, suppression persistence, release, repeated use, or
  non-waiting lane behavior.
- The review-package builder did not consume the lane sidecar and did not require
  any treatment exposure before declaring the package ready.

The first review result is still an accurate record of Luke's choices over those
15 pairs. It is not evidence that G2 is better, equal, or worse than G2 OFF.

## Non-negotiable boundaries

1. The comparison variable is only the complete G2 bundle. Events, admitted
   Memory Claims, Person Portrait, retrieval result, Persona, locale, safety,
   `conversation.text` configuration, and the controlled ordinary main response
   for each turn are identical across arms. Prior Assistant history may differ
   only by earlier ON segments and their resulting state transitions.
2. The OFF arm never executes Open Loop or proactive selection code.
3. The ON arm uses production Open Loop extraction/admission, selection,
   reservation, segment generation, composition, typed use, disposition, and
   suppression code at the seams each case claims to test.
4. Human review judges visible conversation quality. It does not certify
   database state, lane watermarks, latency, target-pool completeness, or
   command lineage.
5. Formal evidence uses synthetic data only.
6. The G2 bundle remains atomic. The evaluation cannot accept an Open Loop-only
   candidate while the Memory candidate lane is disabled.
7. A missing, empty, stale, mismatched, or unhashed evidence file blocks package
   generation.
8. Do not rerun stochastic outputs until a preference result passes. Freeze one
   eligible capture, review it once, and preserve the result.

## Required reading for the implementation session

Read these before editing:

- `AGENTS.md`
- `docs/README.md`
- issue #207 and its latest comments
- issue #193 sections 7, 13, and 14.3-14.4
- `docs/plans/issue-207-implementation-contract.md`
- this plan
- `docs/evaluation/01-behavior-contract-and-rubric.md`
- ADR-0042, ADR-0043, ADR-0044, ADR-0110, ADR-0114, ADR-0117,
  ADR-0132, ADR-0135, ADR-0136, and ADR-0138

Preserve untracked `.agent-context` and `.agent-parent-branch`. Do not modify the
separate worktree at `/Users/lukemyself/Projects/SayHear`.

## Target evidence model

The redesign has three independent evidence tracks. None can substitute for
another.

### Track A: deterministic bundle conformance

Use production application code with deterministic providers and controlled
repositories. Prove:

- Open Loop formation, closure, expiry, source fencing, and same-turn exclusion;
- complete Open Loop and Memory candidate lanes;
- full candidate-pool ordering and zero-or-one selection;
- direct-task, substantive-topic, high-risk, and incomplete-lane correct-zero;
- ordinary-question precedence;
- reservation, segment-command binding, pre-display revalidation, atomic typed
  use, and main-response preservation;
- next-Event disposition;
- refusal, topic-change, short-response, and evasion suppression persistence;
- legal release and illegal release rejection;
- retry starts without old reservation, state, or segment;
- no proactive Provider retry;
- no waiting for an incomplete DialogueState or candidate lane.

These checks should use unit and system tests, not human ratings.

For the "no waiting" contract, prove event ordering rather than wall-clock
speed. Make DialogueState and lane readers return an immediate `incomplete`
snapshot, instrument reads and scheduling, and assert:

- each source is read once;
- no poll, sleep, retry, or completion subscription is scheduled;
- no segment Provider call occurs;
- the already completed main response proceeds directly to commit.

This does not claim that database I/O has zero latency. It proves that the
harness does not wait for incomplete state to become complete.

### Track B: real-Provider treatment capture

Run actual pinned adapters over fixed synthetic inputs. Prove that each case
reaches its declared treatment state.

The capture produces a hash-bound `treatment-ledger.json`. Each case contains
setup evidence and a `turns` array. Record this minimum shape:

```text
fixtureId
caseKind                    # positive | stateful | correct_zero
expectedTreatment
cleanIncumbentManifestFingerprint
cleanIncumbentCommit
openLoopExtractAttempts
openLoopProposalCount
openLoopAcceptedCount
openLoopSkipped[]           # reason codes only
formedTargetRefs[]
turns[]
  sequenceInScenario
  userInputFingerprint
  controlledMainResponseFingerprint
  off
    finalResponseFingerprint
    g2CodePathEntered        # always false
  on
    finalResponseFingerprint
    openLoopLane
      status
      watermark
      manifestVersion
      integrity
    memoryLane
      status
      watermark
      manifestVersion
      integrity
    candidates[]
      targetRef
      lane
      rankTuple
      current
      eligible
      sensitive
      trustFence
      stateVersion
      suppressionReason
      cooldown
      formedInCurrentTurn
      mentionedInExchange
    selectionManifestVersion
    selectionOutcome
    selectionReason
    selectedTargetRef
    ordinaryQuestionCount
    reservationOutcome
    segmentCommandId
    segmentProviderCallCount
    segmentOutcome
    segmentFingerprint
    preDisplayOutcome
    typedUseOutcome
    dispositionOutcome
    suppressionStateAfterTurn
    releaseOutcome
    componentVersions
```

The ledger stores no Provider secret and no production content. It may contain
the synthetic fixture text already committed in the catalog.

### Track C: blind human experience review

The HTML contains only the full synthetic conversation transcript for A and B,
turn boundaries, and the rating controls. Do not show fixture descriptions,
coverage tags, target identities, lane status, expected treatment, or sidecar
diagnostics. Those details would prime the reviewer.

Luke records A / tie / B for every comparable turn and once for the complete
case. Optional notes remain available.

## Prerequisite: complete the candidate before evaluating it

The current production stage has `MEMORY_LANE_DISABLED`. That conflicts with the
complete selector contract in ADR-0044 and issue #193 section 14.4.

Before building new evaluation artifacts:

1. Implement the production Memory candidate reader for the proactive stage.
2. Feed the same current, fenced query-retrieved and Person Portrait claims used
   by the frozen Context into the Memory lane.
3. Emit a complete Memory lane watermark and manifest.
4. Preserve the complete-pool fail-closed rule. If either enabled lane is
   incomplete or unavailable, select no target.
5. Add system coverage for mixed Open Loop and Memory pools, including stable
   ordering, sensitivity ordering, current-exchange exclusion, suppression,
   and trust fences.
6. Remove the deferred Memory-lane comment only when production composition
   supplies the lane.

Completion criterion: a production-seam test selects an eligible Memory Claim
and commits one isolated segment, while a missing Memory watermark makes the
same turn select nothing.

If Luke intends G2 to ship without Memory targets, stop and change the accepted
scope explicitly before continuing. Do not silently redefine the bundle in eval
code.

## Prerequisite: bind the accepted incumbent and expression winner

The OFF arm is the accepted clean 1A.3a incumbent, not any convenient G2-disabled
configuration. Before capture:

1. Verify `eval/continuation-acceptance-1a3b/run/clean-incumbent.json` with its
   existing verifier.
2. Bind its full commit, manifest fingerprint, `conversation.text` provider/model
   configuration, Prompt, Persona, locale, safety, Memory, retrieval, and
   Portrait pins into the v2 manifest.
3. Refuse an OFF run whose configuration differs from that manifest.
4. Carry the clean-incumbent manifest fingerprint and commit into every case in
   the treatment ledger.

Issue #207 and ADR-0136 also require at least two complete
`proactive.followup` expression configurations. The ON-vs-OFF review does not
replace that comparison.

Before choosing the ON expression pin:

- locate the accepted two-configuration evidence if it already exists and bind
  its runs, blind result, and winning configuration into the v2 manifest; or
- run a separate blind expression comparison over treatment-positive segment
  inputs using actual adapters and frozen target/main-response inputs.

Do not mix expression-config selection scores into AC-X01 ON-vs-OFF scores. If
the repository evidence consists only of the four-call v2 smoke, stop and ask
Luke whether to complete the ADR-0136 blind comparison or explicitly supersede
that requirement.

Completion criterion: the v2 manifest names one verified clean OFF
configuration and one human-selected ON expression configuration, with hashes
to the evidence that authorized each.

## Fixture redesign

Create a new catalog version, for example `1a3b-g2-continuation:v2`. Keep the
old v1 catalog and failed package unchanged.

### Case structure

Each case contains:

- synthetic historical User Events in natural first-person language;
- expected accepted domain setup, including target kind and eligibility;
- frozen admitted Memory Claims and retrieval/Portrait selection;
- two to four current conversation turns;
- expected treatment checkpoints per turn;
- human-visible turns separated from operator-only expectations.

Historical Events must look like real user utterances. Avoid phrases such as
"the fictional user" inside the Event body. Synthetic provenance belongs in
catalog metadata, not in the conversation text.

### Pool composition

Build at least 24 eligible scenes so deterministic sampling has room to select
15 without duplicating one Cedar narrative across the whole review.

Use varied synthetic topics, names, times, and emotional stakes. Include both
Open Loop kinds and both Memory kinds. No topic should dominate more than three
of the selected 15 cases.

The pool needs these case families:

| Family | Minimum | Human-visible purpose | Deterministic proof |
| --- | ---: | --- | --- |
| Positive Open Loop | 5 | Is the added question or acknowledgment natural and useful? | Prior Event forms an eligible Loop; ON commits exactly one segment |
| Positive Memory | 5 | Does remembered care feel specific and proportionate? | Memory lane selects the expected current Claim; ON commits exactly one segment |
| Stateful suppression | 6 | Does the full conversation respect the user's direction without becoming awkward? | Prior use, next-Event disposition, later suppression, and optional legal release |
| Correct-zero controls | 6 | Does ON avoid intruding into a task, risk, current topic, or incomplete state? | Explicit zero-selection reason; no segment Provider call |
| Competing pool | 4 | Does the chosen visible topic feel like the right one? | Both lanes complete; deterministic rank selects the declared target |

One scene may cover more than one family, but its expected checkpoints must be
explicit.

### Proposed 15-case review shape

Keep 8 English, 5 Chinese, and 2 code-switch. The deterministic sampler should
select a review set with this shape:

- 4 positive Open Loop cases;
- 4 positive Memory cases;
- 4 stateful suppression cases;
- 3 correct-zero controls.

Required protected coverage remains:

- high risk;
- refusal;
- short answer;
- topic change;
- direct task.

At least six selected cases must commit an ON-only segment. At least two of
those must be Memory targets and at least two must be Open Loop targets. At
least three selected cases must exercise a later-turn suppression checkpoint.

Treat these as minimum exposure constraints, not quotas to optimize against.

### Multi-turn stateful patterns

Use patterns whose shared User turns remain plausible in both arms.

Example refusal pattern:

1. User opens with a natural pause.
2. ON may append one proactive segment; OFF shows the identical main response.
3. User says they would rather not discuss that target.
4. Both arms receive the same neutral continuation.
5. ON must not select the target again. A later explicit target-specific
   permission may test release.

Example topic-change pattern:

1. ON uses one target at a natural gap.
2. User moves to another substantive topic without answering it.
3. Deterministic disposition records `topic_changed`.
4. A later natural gap shows that ON does not repeat the target during cooldown.

Example short-response pattern:

1. ON uses one target.
2. User gives a brief complete answer.
3. The following turn proves the target is suppressed even though the answer was
   not a refusal.

The human transcript proves whether the sequence feels respectful. The
treatment ledger proves the state transitions.

## Causal pairing design

Use a controlled-main-response replay. Generate and freeze one ordinary main
response per fixture turn before arm execution, then make the harness's pinned
conversation adapter replay that exact response in both arms.

For every turn:

1. Generate each controlled main response once with the verified clean-incumbent
   `conversation.text` configuration and save its Provider-call evidence.
2. Check that the response is plausible after the shared User turn in both the
   OFF and ON transcript. If an earlier ON segment makes it implausible, revise
   the synthetic scene before capture, not the frozen response afterward.
3. During arm execution, compile each arm's real current Context and replay the
   same controlled main response through the harness adapter.
4. OFF commits that response unchanged and never enters G2 code.
5. ON passes the same response to the G2 stage. It either commits the unchanged
   response or composes one isolated proactive segment.
6. Assert the ON pre-composition main-response fingerprint equals OFF exactly.

The ON transcript may contain earlier proactive segments that the OFF transcript
does not. That history difference is the treatment's causal consequence. Do not
claim that complete multi-turn histories are identical. The controlled adapter
isolates the optional stage by holding the ordinary response fixed at each turn,
while production repositories and stage code process each arm's actual prior
history and state.

This is a controlled component replay, not evidence about how
`conversation.text` would adapt to divergent prior Assistant history. AC-X01
judges the added G2 experience; broader full-stack conversation adaptation stays
outside this comparison unless a separate evaluation contract is approved.

Do not independently call `conversation.text` for the two arms. Model sampling
noise is not the treatment under review.

For a correct-zero turn, OFF and ON may be byte-identical. That is expected. The
HTML may show identical text; deterministic evidence must explain the zero
selection reason.

## Extraction and domain setup

The new capture must not depend on an unobserved empty extraction result.

For each Open Loop case:

1. Run the real pinned `open_loop.extract` Provider over the historical Event.
2. Record proposal count and deterministic admission results.
3. Require the expected Open Loop to form before the reviewed turn.
4. Require its kind, evidence locator, eligibility window, expiry, and current
   status to match the fixture expectation.
5. Abort the case if no expected Loop forms. Do not fall back to manually
   inserting a Loop in the real-Provider capture.

Use deterministic pre-seeded Open Loops only in Track A tests. Track B and the
human package must prove the actual extraction/admission path.

For Memory cases, load already-admitted synthetic Claims through the production
Memory lane reader. Do not ask `open_loop.extract` to create Memory state.

## Capture eligibility gate

Add a verifier that runs before review-package construction. Suggested command:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/verify-g2-treatment.ts \
  --catalog eval/continuation-acceptance-1a3b/fixtures-v2.json \
  --off-run eval/continuation-acceptance-1a3b/run-v2/continuation-off.json \
  --on-run eval/continuation-acceptance-1a3b/run-v2/continuation-on.json \
  --ledger eval/continuation-acceptance-1a3b/run-v2/treatment-ledger.json
```

The verifier fails unless all conditions hold:

- both runs contain every fixture and turn;
- all frozen inputs and main-response fingerprints match across arms;
- all Provider/model/Prompt/Schema/policy pins match the manifest;
- the OFF configuration matches the verified clean-incumbent manifest;
- the ON expression configuration matches the separately authorized winner;
- every positive case commits exactly the declared segment and typed use;
- every stateful case reaches every declared state checkpoint;
- every correct-zero case records the declared deterministic reason and makes no
  segment Provider call;
- both enabled lanes carry the expected complete watermark, manifest version,
  integrity, and component versions whenever selection runs;
- the complete candidate list reconstructs from both lanes, including every
  rank tuple, trust fence, state fence, sensitivity bit, and exclusion flag;
- the expected target exists in that reconstructed pool and wins the declared
  lexicographic ordering;
- no current-turn Open Loop is selected;
- no ordinary-question turn appends a segment;
- each incomplete-state control reads each source once, schedules no poll,
  sleep, retry, or completion wait, and proceeds to main-response commit;
- all segment calls use the pinned `proactive.followup` role with zero retry;
- no case has an unclassified skip, provider error, or missing sidecar field;
- full-pool hard gates pass;
- the verified eligible pool contains enough cases for the sampler to satisfy all
  exposure, language, category, topic-diversity, and A/B-balance constraints.

Completion criterion: changing any one main-response hash, lane status, selected
target, segment count, disposition, or suppression checkpoint makes the
verifier exit non-zero.

## Manifest and package changes

Version the protocol instead of adding optional fields to v1.

Suggested new artifacts:

```text
eval/continuation-acceptance-1a3b/run-v2/
  manifest.json
  clean-incumbent-verification.json
  expression-selection-manifest.json
  continuation-main.json
  continuation-off.json
  continuation-on.json
  treatment-ledger.json
  treatment-verification.json
  continuation/
    pairs.json
    input-summary.json
    hard-gates.json
    treatment-summary.json
    review-package.json
    sealed-identities.json
    scores.json
    index.html
```

`manifest.json` must hash every file used to admit review-package construction,
including `treatment-ledger.json` and `treatment-verification.json`.

`review-package.json` must carry the treatment-verification fingerprint but not
the sealed treatment details shown only to operators after review.

`input-summary.json` should say precisely:

> Both arms use the same frozen inputs and byte-identical ordinary main
> responses. The ON arm may add only the isolated G2 segment and its resulting
> state transitions.

Do not claim that only the bundle differs unless the verifier has proven this
for every turn.

## Sampling and blinding

1. Select the 15 cases only after treatment verification passes for the full
   pool.
2. Use a new sample seed and a separate new identity seed.
3. Balance candidate position across the 15 cases: candidate appears as A in 7
   cases and B in 8, or the reverse.
4. Balance position within each language as closely as possible.
5. Do not expose global `baselineSource=A` or `candidateSource=B` metadata.
6. Generate sealed identities and public pairs from the same assignment object.
7. Add a verifier that reconstructs every A/B response from the sealed mapping
   and source runs.
8. Keep sealed identities local until Luke completes all 15 cases.

Package construction, not the pre-sampling treatment verifier, validates the
actual selected sample against language, category, topic-diversity, exposure,
duplicate, and A/B-position constraints. The package builder must consume only
cases admitted by the earlier treatment verification.

Completion criterion: a test catches any response swap, unbalanced assignment,
identity leak, duplicate case, quota miss, or package fingerprint drift.

## HTML requirements

Reuse the existing offline review page only where its behavior is correct.

The page must:

- render the complete multi-turn transcript for both arms;
- align matching User turns and label Assistant A / Assistant B clearly;
- collect one A / tie / B choice per comparable Assistant turn;
- collect one overall A / tie / B choice per case;
- keep notes optional;
- show progress as completed cases out of 15;
- require reviewer name before export;
- write the package fingerprint and protocol version into `scores.json`;
- clear incompatible local drafts when the package fingerprint changes;
- work from `file://` with no network requests;
- remain usable at desktop width and 390 px mobile width;
- never include sealed identities, treatment expectations, or hidden comments
  that reveal the arms.

Add a compact instruction at the top:

> Judge which full conversation you would keep for the product. Use tie when the
> difference is not meaningful. Do not infer internal implementation from the
> wording.

Before handing the page to Luke, inspect it in Chrome at desktop and 390 px,
complete a throwaway review, reload to verify draft recovery, export scores,
clear the draft, and verify offline rendering.

## Tests to add before implementation changes

Write failing tests first at these seams:

1. Review-package construction rejects a candidate with zero committed segments
   across all positive cases.
2. It rejects a positive Open Loop case with zero accepted formations.
3. It rejects a positive Memory case while the Memory lane is disabled or
   incomplete.
4. It rejects independently generated or changed main responses across arms.
5. It rejects a stateful case missing a disposition or later suppression
   checkpoint.
6. It rejects a correct-zero case that called `proactive.followup`.
7. It rejects a lane sidecar absent from the manifest or changed after hashing.
8. It rejects an imbalanced A/B assignment.
9. It rejects single-turn fixtures that declare persistence or release coverage.
10. It reconstructs every public response from source runs and sealed mapping.
11. It rejects a treatment ledger that flattens or omits a required turn.
12. It rejects a lane snapshot missing watermark, manifest, candidate, rank,
    state, trust-fence, or component-version evidence.
13. It rejects an OFF run not bound to the verified clean incumbent.
14. It rejects an ON run not bound to the authorized expression winner.
15. It proves incomplete state is read once with no poll, retry, sleep, or wait
    before main-response commit.

Keep the old v1 tests unchanged unless they are factually wrong. Add v2 tests
beside them so old evidence remains readable.

## Implementation layers

### Layer 1: freeze the failed v1 evidence

- Keep the current failed scores, results, ledger, review package, and lane
  sidecar unchanged.
- Add no compatibility path that lets v1 satisfy v2 treatment verification.

Completion criterion: v1 remains readable and unblindable, while every v2
builder rejects v1 artifacts.

### Layer 2: complete the production Memory lane

- Implement the missing Memory candidate reader and production wiring.
- Add focused unit and PostgreSQL system tests.
- Confirm complete-pool fail-closed behavior with both lanes enabled.

Completion criterion: production-seam Open Loop, Memory, mixed-pool, and missing
lane tests pass.

### Layer 3: settle incumbent and expression evidence

- Verify and bind the accepted clean incumbent.
- Bind an existing ADR-0136-compliant expression comparison or run the missing
  two-configuration blind comparison.
- Freeze the selected ON expression pin before ON-vs-OFF capture.

Completion criterion: both OFF and ON configurations have independent,
hash-bound authorization evidence.

### Layer 4: add v2 fixtures and deterministic conformance

- Add the varied multi-turn pool and fixture validation rules.
- Implement deterministic Track A tests for every declared checkpoint.

Completion criterion: every fixture expectation is reproduced by production
selection/state code, and removing a required turn makes fixture validation
fail.

### Layer 5: build causal real-Provider capture

- Generate each controlled ordinary main response once with the clean incumbent.
- Replay it through both arm harnesses, using each arm's real prior state.
- Run OFF unchanged and ON through the complete G2 stage.
- Save the treatment ledger with proposal, selection, segment, and state data.
- Preserve Provider errors as failed evidence. Do not omit failed fixtures.

Completion criterion: the full pool completes with no provider/configuration
errors and passes `verify-g2-treatment.ts`.

### Layer 6: bind manifests and review package

- Hash all source runs and treatment evidence.
- Add fail-closed package construction.
- Add balanced deterministic blinding.

Completion criterion: any one-byte change to an admitted artifact blocks package
verification.

### Layer 7: generate and inspect the HTML

- Build the new 15-case package and page.
- Perform desktop, mobile, persistence, export, and offline checks.
- Scan generated artifacts for credentials and production content.

Completion criterion: all checks pass and the page contains exactly 15 complete,
verified cases with the required 8/5/2 split.

### Layer 8: Luke review and unblind

- Ask Luke to review only after all previous completion criteria pass.
- Validate exported scores against the package fingerprint and every required
  turn/case decision.
- Unblind once.
- Preserve results even if the gate fails.

Completion criterion: the ledger reports strict-positive overall preference and
non-negative locale/protected-category results, or the release stops with the
failed evidence preserved.

## Verification commands

Use repository scripts where they exist. Add package scripts only if they make
the operator path less error-prone.

Minimum local checks:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts
pnpm exec vitest run tests/continuation-acceptance-f3.test.ts
pnpm exec vitest run packages/application/src/proactive-followup.test.ts
pnpm typecheck
pnpm check:boundaries
pnpm check:purge-surfaces
```

Run affected Neon system suites with `.env.neon` loaded through the repository's
env-file parser or explicit variable extraction. Do not `source .env.neon`.
Use `--maxWorkers=2` unless a measured environment limit requires one worker.

Before handing off the HTML, also run:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/verify-g2-treatment.ts \
  --catalog <v2-catalog> \
  --off-run <off-run> \
  --on-run <on-run> \
  --ledger <treatment-ledger>

pnpm exec tsx eval/continuation-acceptance-1a3b/build-review-package.ts \
  --manifest <v2-manifest> \
  --group continuation \
  --baseline-run <off-run> \
  --candidate-run <on-run> \
  --treatment-ledger <treatment-ledger> \
  --out <v2-review-directory>

pnpm exec tsx eval/blind-pairwise/build-review-page.ts \
  --dir <v2-review-directory>
```

Command names and arguments marked by this plan do not exist yet. Implement
their `--help` and README documentation before treating them as operator entry
points.

## Review checklist before Luke sees the page

- The candidate uses the complete G2 bundle, including the Memory lane.
- The OFF arm is bound to the verified clean-incumbent manifest.
- The ON expression pin is bound to a two-configuration decision or an explicit
  superseding decision from Luke.
- The full pool has at least six verified ON-only segment exposures.
- At least two selected exposures are Open Loop targets.
- At least two selected exposures are Memory targets.
- At least three selected cases prove later-turn suppression.
- Every correct-zero case has a deterministic reason and zero segment call.
- OFF and ON pre-composition main-response hashes match turn by turn.
- Every ledger checkpoint is turn-scoped and carries complete lane, candidate,
  rank, fence, and component-version evidence.
- Every reviewed response reconstructs from source runs plus sealed mapping.
- Candidate A/B position is balanced 7/8.
- Language quota is exactly 8/5/2.
- Protected categories are present.
- No identities appear in public JSON, HTML, source comments, DOM attributes, or
  browser storage.
- No credential or production content appears in generated artifacts.
- Desktop, 390 px mobile, draft recovery, export, clear, and offline checks pass.
- The issue comment records commands, commit, artifact hashes, and reviewer-ready
  status without revealing identities.

## Stop conditions

Stop and report instead of generating or publishing the HTML if any condition
occurs:

- Memory targets remain outside the production G2 bundle.
- The clean-incumbent manifest cannot be verified or the OFF pins differ.
- No ADR-0136-compliant expression winner or explicit superseding decision exists.
- A positive case has no accepted target or no committed segment.
- A correct-zero case calls the segment Provider.
- A stateful case lacks a required disposition, suppression, or release record.
- OFF and ON main responses differ before G2 composition.
- A controlled main response is implausible after either arm's preceding visible
  transcript.
- Any enabled lane is incomplete or unavailable during a case that claims
  selection coverage.
- The real Provider capture omits a fixture, returns an unclassified failure, or
  uses mismatched pins.
- The treatment ledger is absent from the manifest or its hash changes.
- Sampling cannot satisfy language, protected-category, treatment-exposure, and
  balanced-position constraints simultaneously.
- Product docs, issue #193, issue #207, ADRs, and the implementation contract
  disagree about whether Memory targets belong in G2.

Do not fix a stop condition by relaxing a verifier, changing a frozen output,
rerunning until a preferred response appears, or moving a failed positive case
into the correct-zero group.

## Definition of done

The redesign is ready for Luke only when:

1. the complete production G2 bundle is present;
2. deterministic bundle conformance passes;
3. a real-Provider full-pool capture passes treatment verification;
4. every reviewed pair has causal provenance from byte-identical main responses;
5. the manifest hashes all admitted evidence;
6. the 15-case HTML passes functional, mobile, offline, secrecy, and export
   checks;
7. a second agent reviews both repository standards and issue/spec compliance;
8. issue #207 receives a reviewer-ready update with hashes and commands, without
   sealed identities.

Only then ask Luke to perform the new blind review.

## Revision 2026-09-18 (Luke-approved grilling) — overrides earlier sections

The following parts of this plan are superseded by the 2026-09-18 decisions
(recorded in `docs/adr/0114-...md` / `docs/adr/0136-...md` amendments,
`CONTEXT.md` under 行为评测, and
`docs/plans/issue-207-implementation-contract.md#evaluation-scene-rework-and-v2-review-package-2026-09-18-luke-approved`):

- "Track C" transcript-only rule (L205-208) is replaced: the review page
  shows both transcripts plus a neutral, arm-blind Context Panel with the
  case-start shared knowledge (seeded Memory Claims / Portrait, prior use /
  suppression state). It still must not show fixture descriptions, coverage
  tags, target identities, lane status, expected treatment, or diagnostics.
- The human sample no longer contains correct-zero scenes and no longer
  forces `high_risk`: sample slots admit Review-Worthy Scenes only (both
  arms differ on a Backend-Decision Product, human judgment required,
  product visible). Full-pool deterministic gates still cover correct-zero,
  suppression persistence/release, and `high_risk`.
- Sample constraints are now: 15 scenes, 8/5/2 language quotas, family
  minimums (>=4 open loop, >=4 memory, >=3 stateful, >=2 competing), topic
  cap <=3, forced `refusal` / `short_answers` / `topic_change` /
  `direct_task`. Scene-level tie rate >1/3 triggers scene redesign.
- Scene eligibility is no longer "the reviewed segment must cite a specific
  declared fact": the panel lets reviewers judge generic-looking segments,
  so specificity became a judged quality, not an admission gate.
- Suppression stays in the human sample through the stateful family (their
  t2 segments are real products); their later-turn silence remains
  contract-verified, not human-judged.
- Reviewed turns of all 16 scenes with generic products were rewritten to
  calm, information-thin turns; capture extraction conditioning retries
  only on fixture-declared loop-source turns.
- The expression prerequisite is settled by a bounded ADR-0136 exception
  (v2 bound as sole verified configuration; no separate style review now),
  not by a second blind comparison.
- Current deliverable path: ON/OFF runs and the v2 package live in
  `eval/continuation-acceptance-1a3b/run-v2/` (`review/index.html`), built
  by `build-review-package-v2.ts` (seeds 207/207, A/B 7/8).
