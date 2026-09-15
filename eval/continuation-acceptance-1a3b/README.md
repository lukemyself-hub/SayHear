# 1A.3b F3 synthetic acceptance tools

F3 owns the reproducible evidence inputs for Continuation, Bio naturalness,
and `narrative.validate`. The catalog is fictional and synthetic. These tools
never connect to PostgreSQL, read `DATABASE_URL`, call a Provider, or read a
production conversation source.

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

After a clean incumbent is frozen, capture the bundle-enabled candidate arm
through the same frozen inputs (the open-loop lane evolves via the production
extract runner; the proactive stage may append an isolated segment):

```sh
pnpm exec tsx eval/continuation-acceptance-1a3b/run-synthetic-candidate-capture.ts \
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
