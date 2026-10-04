# G1 Release Blockers — Canary Retention Metadata and Weekly New-Source Admission

## TL;DR

- Two confirmed G1 delivery blockers are fixed with the smallest suitable change:
  1. The hosted Workflow canary rejected a fully decrypted, hash-matched,
     completely paginated archived export only because the run envelope's
     `expiredAt` retention deadline had elapsed (`expiry <= Date.now()`).
  2. The Weekly Reflection scheduler suppressed a genuinely new source digest
     forever because `listDueWeekWindows` counted any `reflection_runs` row in
     `ready`/`built` without looking at its `generation_commands.status`.
- No model, Prompt, budget, semantic gate, migration, or capture change.
  Shared v12 rollout pins bind the new release; all four configurations stay v5.
  Original archived artifacts are never edited.

## Status

Implemented; independent review cleared; frozen release validation pending.

## Blocker 1 — Canary root retention metadata

### Root cause

`collectUnresolvedDataFindings` treated a root `workflowHistory[N].expiredAt`
(`expiry <= Date.now()`) as unresolved bytes. The archived export fetched on
Oct 3 already contained the full `input`/`output`/`steps`/`events` and complete
pagination whose hashes matched; only the retention deadline had passed by
Oct 4. Wall-clock elapsed time on the run envelope does not prove the bytes
were dropped.

### Decision

Accept any parseable root run-envelope retention timestamp regardless of
elapsed wall-clock time. The proof of a complete export is the shared gate's
full resolved data plus complete-page provenance, execution correlation, and
the privacy-probe scan — all of which still run. Malformed root dates and every
nested `expiredAt` object (serialized expired-data stubs) stay unresolved, as do
encrypted placeholders, stream references, omitted pages, and probe leaks.

## Blocker 2 — Weekly new source suppressed by a historical failed command

### Observed isolated hosted acceptance state (read-only, 2026-10-04)

- `reflection_runs.reflection_run_id` `01a0fd23-ea74-747d-b72e-8e319f3103b7`,
  `date_range`, W38 (`32e8e978-b3b2-532c-8f6b-428c86f8d366`), status `ready`.
- Its `generation_command` `01a0fd23-e843-76e8-adc4-7b058088634a` status
  `failed`, source digest `a144b100…fe76c074`.
- A genuinely new Sep 17 source (real Journal + Episode built Oct 3) is more
  than 30 minutes old and never queues.

### Root cause

`listDueWeekWindows` decided whether to compute a source digest from
`count(*)` of `reflection_runs` in `ready`/`built` for the week window. The
`ready` row left behind by the terminally failed command matched that count, so
the window produced no digest and `queueWeeklyReflection` was never called —
regardless of the new, different source digest. `queueWeeklyReflection` itself
is not the blocker: it re-verifies the digest and dedupes by the
`weekly:<week>:<digest>` intent key, so the "any window" gate is only in the
scheduler read.

### Decision

- A `built` run, or a `ready` run whose generation command is not terminally
  `failed`, keeps owning the window (current history or live/recoverable
  attempt) and blocks re-admission.
- A `ready` run whose generation command is terminally `failed` is frozen
  history. It is preserved untouched, but it no longer suppresses admission of
  a new source digest through the ordinary scheduler path.
- Same-source dedup is retained: if the current digest matches an existing
  terminally failed `ready` run, the scheduler does not re-admit it. No implicit
  retry, no old-run rewrite, no manual run-status or SQL data fabrication.

## In scope

- `scripts/hosted-workflow-canary-gate.ts`: root retention-metadata acceptance.
- `tests/hosted-canary-export.test.ts`: past-retention resolved-pass plus
  nested-stub and leak fail-closed regressions.
- `packages/data/src/postgres-reflection-repository.ts`: `listDueWeekWindows`
  joins `generation_commands` to distinguish a frozen failed attempt from a
  live/current run, with same-source dedup.
- `tests/system/reflection-daily-weekly.system.test.ts`: true system regressions.

## Out of scope

- Any model, Prompt, Schema, budget, semantic-gate, or role-configuration change.
- Daily-scope admission semantics, migrations, workflow recovery internals,
  hosted acceptance execution, release production, and deployment.
- Editing any archived capture or run artifact.

## Acceptance criteria

1. A valid root run `expiredAt` in the past is accepted when the export is
   fully resolved, page-complete, correlated, and probe-clean.
2. A malformed root `expiredAt`, a nested expired-data stub, an encrypted
   placeholder, an unresolved stream reference, an omitted page, and a probe
   leak all still fail closed.
3. With only a `ready` run whose command terminally `failed`, a genuinely new
   source digest is admitted exactly once through `queueWeeklyReflection`; the
   same digest is not re-admitted.
4. A live (`running`) command or a `built` run still prevents duplicate
   admission, and the existing run row is preserved unchanged.

## Validation

- `./node_modules/.bin/vitest run tests/hosted-canary-export.test.ts` — pass.
- `./node_modules/.bin/vitest run tests/hosted-canary-export.test.ts tests/one-a-3b-release-evidence.test.ts` — 33 pass.
- `TEST_DATABASE_URL=postgresql://localhost/sayhear_test ./node_modules/.bin/vitest run tests/system/reflection-daily-weekly.system.test.ts` — 15 pass.
- Both regression sets were confirmed to fail against the pre-fix behavior
  before the fix was restored.
- `tsc --noEmit` for `tsconfig.json`, `tsconfig.g1-tools.json`, and
  `packages/data/tsconfig.json` — clean.

## Required context

- [ADR-0144](../adr/0144-g1-hosted-acceptance-isolated-from-production.md)
- [ADR-0143](../adr/0143-g1-ships-without-semantic-reflection-validation.md)
- [ADR-0134](../adr/0134-1a3b-rollout-is-staged-and-correctness-triggered.md)
- [ADR-0083](../adr/0083-generation-commands-use-versioned-freshness-policies.md)
- [ADR-0089](../adr/0089-derived-artifacts-are-versioned-and-projections-are-rebuildable.md)

## Open questions

- Full exact-main regression, hosted acceptance, and production promotion remain
  owned by the parent task and are not claimed here.
- No official SPEC was found that forbids admitting a new Weekly source after a
  terminal failed command; the observed blocker is the scheduler read.

## References

- [Documentation map](../README.md)
- [Decision index](../decisions.md)

Parent verification: 37/37 tests passed with no skips on the designated\nindependent business and Purge Marker test databases at port 55439, using\nmaxWorkers=2. Full typecheck, runtime, boundaries, and Purge inventory checks\npassed. OpenCode independent Review cleared the complete diff, including the\nv12 release-identity-only pins. Frozen release evidence remains pending.\n