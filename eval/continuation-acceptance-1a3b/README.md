# 1A.3b F3 synthetic acceptance tools

F3 owns the reproducible evidence inputs for Continuation, Bio naturalness,
and `narrative.validate`. The catalog is fictional and synthetic. Fixture,
manifest, review, and verification tools never connect to PostgreSQL, read
`DATABASE_URL`, or read a production conversation source. The capture tools
call the pinned Provider only with the versioned synthetic catalog.

## What is frozen

`fixtures.json` contains three independent groups:

- an 18-fixture Continuation pool, from which the tool selects 15 scenarios
  with the ADR-0114 quota of 8 English, 5 Chinese, and 2 code-switch cases;
- 15 separate Bio-naturalness fixtures, five per language variant;
- 18 validator fixtures, with four Bio and two Reflection cases for each
  language variant, covering unsupported, contradiction, epistemic upgrade,
  material absence, manifest mismatch, and ambiguity.

`pins.json` records all seven independently pinned roles and the two complete
Bio configurations. It records no winner. `baseline-reference.json` keeps the
#166 incumbent and confirmed #186 findings visible. Its default
`requires-clean-rebaseline` status intentionally blocks formal pairing until a
fresh incumbent has zero confirmed deterministic hard-gate failures.

## Commands

Verify the complete fixture pool first:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/verify-fixtures.ts
```

Create a manifest from an exact checkout. The manifest records the commit,
fixture and sampling seeds, every role pin, reproduction commands, fixture
hashes, sample IDs, and the AC-X01/X02/X03/X04/AC-M01 ownership map:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/build-manifest.ts \
  --out eval/continuation-acceptance-1a3b/run/manifest.json \
  --git-commit <full-40-character-commit>
```

The manifest fingerprint excludes only its creation timestamp, so rebuilding
with the same inputs, pins, commit, commands, and seeds gives the same
fingerprint. The timestamp remains in the artifact for run provenance.

Provider adapters or a later synthetic capture must write this small run
shape: `version`/`format` `1a3b-f3-synthetic-run:v1`, `synthetic: true`,
`sourceKind: "synthetic-eval"`, the pinned `configId` and its exact
`configurationFingerprint`, the group, and every fixture in the complete pool.
Each scenario must carry the SHA-256 fingerprint
of its catalog shared input and, for Bio, the SHA-256 fingerprint of its exact
prompt (`null` for Continuation); each turn must carry the exact catalog user input
plus the resulting `assistantText`. Both arms therefore prove that their
Events, Memory, retrieval, Portrait, Persona, locale, safety, and Conversation
inputs came from the same frozen catalog entry before pairing.

Capture a clean incumbent with an explicit env file. Explicit loading overrides
stale inherited values and parses `.env.neon` without shell-expanding special
characters in database URLs:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/run-synthetic-capture.ts \
  --env-file .env.neon \
  --git-commit <full-40-character-product-commit> \
  --baseline-manifest-out eval/continuation-acceptance-1a3b/run/clean-incumbent.json
```

Only a complete real-provider run with 18/18 passing hard gates writes the
clean-incumbent manifest. The acceptance-manifest builder re-reads the run and
hard-gate report, recomputes the gates, and verifies both hashes.

After a clean incumbent is frozen, capture the bundle-enabled candidate arm
through the same frozen inputs (the open-loop lane evolves via the production
extract runner; the proactive stage may append an isolated segment):

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/run-synthetic-candidate-capture.ts \
  --env-file .env.neon \
  --out eval/continuation-acceptance-1a3b/run/continuation-candidate.json
```

Then build either blinded review package:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/build-review-package.ts \
  --manifest eval/continuation-acceptance-1a3b/run/manifest.json \
  --group continuation \
  --baseline-run <synthetic-incumbent-run.json> \
  --candidate-run <synthetic-candidate-run.json> \
  --out eval/continuation-acceptance-1a3b/run/continuation

pnpm exec tsx eval/blind-pairwise/build-review-page.ts \
  --dir eval/continuation-acceptance-1a3b/run/continuation
```

The package checks both complete pools before selecting the human sample. It
writes `pairs.json`, `sealed-identities.json`, `input-summary.json`,
`hard-gates.json`, `review-package.json`, and a score template. A Bio package
also writes `bio-inspection-template.json`; it is intentionally an incomplete,
failing template until Luke selects the revealed configuration and records all
15 fixed-sample rulings.

The public pair file and public package metadata contain only A/B responses and reproducibility
metadata. The sealed file carries the arm mapping and must remain with the
unblinder; it is not opened until every turn and every scenario has a human
A/tie/B choice.

Reveal a completed pairwise review only after the human score file is present:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/unblind.ts \
  --dir eval/continuation-acceptance-1a3b/run/continuation
```

This writes arm-level counts and a pairwise adjudication ledger. Continuation
gets the strict-positive, per-language, and protected-category regression
calculations; any failed Continuation gate exits non-zero. Bio keeps
the winner unset and records that Luke must inspect the fixed sample of the
human-selected configuration, as required by AC-X02. The first Bio reveal
provides the sealed identities and exits non-zero until `bio-inspection.json`
is filled from `bio-inspection-template.json`; after selecting the revealed
configuration and marking all 15 entries, a second run exits non-zero if any
inspection ruling is unacceptable.

The separate validator ledger is human-owned and cannot be replaced by a
machine verdict:

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/validate-ledger.ts \
  --manifest eval/continuation-acceptance-1a3b/run/manifest.json \
  --ledger <validator-ledger.json>
```

## Evidence boundaries

The full Continuation pool is checked for the one-question, required-token,
and forbidden-token hard gates before the 15-case preference sample is built.
Shared events, frozen Memory, retrieval, Portrait, Persona, locale, safety,
and Conversation configuration are hashed once per fixture. The input summary
declares the only intended comparison difference: Open Loop / Proactive bundle
for Continuation, or the complete Bio writer/validator configuration for Bio.

The tools produce evidence artifacts; they do not claim that a Provider run,
hosted Workflow export, Luke's review, or formal release acceptance has
happened. Those remain separate AC-X and hosted evidence steps.

## G2 v4 dual-track review

Issue #207's v4 tools are separate from the frozen v2 and v3 evidence. They use
hand-authored `fixtures-v4/`, `pins-v4.json`, and `run-v4/`. Each main-response
turn is captured once; a main response containing a question is retained and
left to the production gate. The full-pool verifier must pass before a review
package can be built.

Run the capture only from a clean, committed evaluator checkout with the
approved provider environment. Never pass production conversation data to
these synthetic captures:

```sh
node --import tsx/esm eval/continuation-acceptance-1a3b/verify-fixtures-v4.ts
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v4-capture.ts \
  --mode main --env-file .env.neon
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v4-capture.ts \
  --mode off --env-file .env.neon
node --import tsx/esm eval/continuation-acceptance-1a3b/build-v4-expression-selection.ts
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v4-capture.ts \
  --mode on --env-file .env.neon \
  --expression-selection eval/continuation-acceptance-1a3b/run-v4/operator/expression-selection.json
node --import tsx/esm eval/continuation-acceptance-1a3b/verify-g2-treatment-v4.ts
node --import tsx/esm eval/continuation-acceptance-1a3b/build-review-package-v4.ts
```

The package builder selects 15 actual committed emits and eight predeclared
typed omissions. Public artifacts are in `run-v4/review/`; sealed identities
and unblind inputs stay in `run-v4/operator/`. Do not open the sealed mapping
before the human review is complete.

Start the offline review page on localhost:

```sh
pnpm eval:g2:v4:review
```

Open <http://127.0.0.1:4177/>. The page saves drafts in browser local storage,
exports `scores-v4.json`, and does not load remote assets. After the reviewer
has completed and exported the score file, unblind with the package, score,
and operator-only mapping:

```sh
pnpm eval:g2:v4:unblind -- \
  --public eval/continuation-acceptance-1a3b/run-v4/review/public-package.json \
  --scores eval/continuation-acceptance-1a3b/run-v4/review/scores-v4.json \
  --sealed eval/continuation-acceptance-1a3b/run-v4/operator/sealed-identities.json \
  --out eval/continuation-acceptance-1a3b/run-v4/operator/unblinded-v4.json
```

The v4 unblinder verifies the raw payload fingerprint before reading sealed
identities. The legacy pairwise unblinder accepts only its v1/v2 protocols.

## G2 v5 precision-first acceptance

v5 keeps the v4 evidence immutable and runs in separate paths. First generate
and verify the independent 44-scene calibration set, then run its main, OFF,
and ON captures once. Analyze the result before authoring the formal pool:

```sh
node --import tsx/esm eval/continuation-acceptance-1a3b/verify-fixtures-v5.ts \
  eval/continuation-acceptance-1a3b/fixtures-v5-calibration-1.json
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode main --catalog eval/continuation-acceptance-1a3b/fixtures-v5-calibration-1.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json \
  --env-file .env.neon \
  --main-out eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-main.json
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode off --catalog eval/continuation-acceptance-1a3b/fixtures-v5-calibration-1.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json \
  --env-file .env.neon \
  --main-in eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-main.json \
  --off-out eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-off.json
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode on --catalog eval/continuation-acceptance-1a3b/fixtures-v5-calibration-1.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json \
  --env-file .env.neon \
  --main-in eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-main.json \
  --on-out eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-on.json \
  --ledger-out eval/continuation-acceptance-1a3b/run-v5-calibration-1/treatment-ledger.json \
  --expression-selection eval/continuation-acceptance-1a3b/run-v5/operator/expression-selection.json
node --import tsx/esm eval/continuation-acceptance-1a3b/verify-g2-treatment-v5.ts \
  --catalog eval/continuation-acceptance-1a3b/fixtures-v5-calibration-1.json \
  --main-run eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-main.json \
  --off-run eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-off.json \
  --on-run eval/continuation-acceptance-1a3b/run-v5-calibration-1/continuation-on.json \
  --ledger eval/continuation-acceptance-1a3b/run-v5-calibration-1/treatment-ledger.json \
  --verification eval/continuation-acceptance-1a3b/run-v5-calibration-1/verification.json
node --import tsx/esm eval/continuation-acceptance-1a3b/analyze-v5-calibration.ts
```

The analyzer requires nonzero executable emits in every positive family and
three matching typed omissions for each reason. It computes each formal family
size as `ceil(2k/p)`, rounds up to ten, then enforces the 80–160 positive-pool
bound. A zero rate, unstable omission, or over-cap plan pauses formal capture.
If a demonstrated defect needs a second calibration, generate round 2; never
reuse or resample round 1 scenes.

Only after calibration passes, generate the formal fixtures from the frozen
family counts, verify the catalog, and prepare its pre-registration:

```sh
node --import tsx/esm eval/continuation-acceptance-1a3b/prepare-v5-formal.ts
```

Review and commit the implementation and pre-registered inputs, then confirm
the tracked worktree is clean before the first formal Provider call. The
current catalog freezes three ordered batches inside the 80–160 positive-scene
cap; all eight omission audits and the correct-zero controls are in batch 1.
Each formal turn is captured once. Begin with batch 1:

```sh
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode main --catalog eval/continuation-acceptance-1a3b/fixtures-v5.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json --env-file .env.neon --batch batch-1
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode off --catalog eval/continuation-acceptance-1a3b/fixtures-v5.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json --env-file .env.neon --batch batch-1
node --import tsx/esm eval/continuation-acceptance-1a3b/run-v5-capture.ts \
  --mode on --catalog eval/continuation-acceptance-1a3b/fixtures-v5.json \
  --pins eval/continuation-acceptance-1a3b/pins-v5.json --env-file .env.neon \
  --batch batch-1 \
  --expression-selection eval/continuation-acceptance-1a3b/run-v5/operator/expression-selection.json
pnpm eval:g2:v5:merge --batches batch-1
pnpm eval:g2:v5:verify
```

Batch runs write isolated files under `run-v5/batches/<batch-id>/`; OFF and ON
replay that same batch's frozen main file. After each merge and verification,
run the next batch only when `passed` is true, `reviewReady` is false, and
`pendingSampleQuotas` is nonempty. For batch 2 or 3, repeat the three capture
commands with that exact `--batch` ID, then merge the ordered prefix, for
example `pnpm eval:g2:v5:merge --batches batch-1,batch-2`, and verify again.
Stop when `reviewReady` is true or any hard gate fails; recall failure never
triggers another batch. The verifier checks exact scene/turn sets, frozen main
text, raw and canonical hashes for each batch, typed treatment state, and
recall when the sample becomes available or all batches are exhausted. The
page builder refuses to run unless final verification has zero failures,
marks `reviewReady`, and supports the fixed-seed ten-case quotas.

After a passing verifier, build and serve the human page with:

```sh
node --import tsx/esm eval/continuation-acceptance-1a3b/build-review-package-v5.ts
pnpm eval:g2:v5:review
```

It contains ten actual emit comparisons and eight typed-omission judgments.
The public page and operator mapping stay separate. Do not unblind before the
reviewer exports all scores; v5 unblinding checks the 10/8 sample, 5/5 arm
placement, every protected-turn reference, omission quotas, and the package
fingerprint. A passing review still does not create or publish a G2 manifest.
