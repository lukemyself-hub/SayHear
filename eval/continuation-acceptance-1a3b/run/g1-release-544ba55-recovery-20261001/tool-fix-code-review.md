No P1 fail-open in scoped diff. Do not claim new Provider/deployed G1 complete — production remains OFF, refreeze/revalidate still required.

Confirmed OK:

* Legacy fingerprint: `packages/application/src/one-a-3b-release.ts:277-289,777,1111` shares helper builder/verifier, omits `catalogPath` when `undefined`, `stableJson` sorted. Test `one-a-3b-release.test.ts:334-340` proves byte-identical `sha256Hex(legacyFixture)`. No-path legacy preserved, pinned path changes hash, swap rejected.
* Malformed path: builder `367-370` throws, verifier `1102-1108` mismatches. Test `363-370` covers `catalogPath:7`. Empty/whitespace/null also rejected by same branches.
* False-pass rejection: contract `one-a-3b-release-evidence.ts:212-230` adds both keys, producer copies via `evidenceArtifactValue:1591-1599`, missing-key blocked via `produce-1a3b-g1-evidence.ts:1414-1422`, final rescan throws verified by `tests/one-a-3b-release-evidence.test.ts:593-614`.
* No semantic tuning/model switch/waiver expansion in diff.

P2-1 — Test imports CLI side-effect module:
File/line: `tests/one-a-3b-release-evidence.test.ts:9` + `scripts/produce-1a3b-g1-evidence.ts:1960-1965,1581`.
Trigger: `import {evidenceArtifactValue}` executes unconditional `main()` with vitest `process.argv`, which always `writeReport` + may stage/write evidence, `console.error`, mutates `process.exitCode`. `verify-*.ts` has no `main`, safe; producer does.
Impact: test pollution/flake, stray report writes, exit-code side effect; new in this diff via `export`.
Fix: guard `main()` behind entrypoint check (`process.argv[1]` ends with script) or move pure `evidenceArtifactValue` to library and keep script thin.

P2-2 — Producer `expectedRunIds` syntactic only, comment overstates completeness:
File/line: `scripts/produce-1a3b-g1-evidence.ts:1229-1239` vs final `scripts/verify-1a3b-g1-evidence.ts:212-228` + `scripts/hosted-workflow-canary-gate.ts:129-164` exact-match.
Trigger: source with valid regex/unique `expectedRunIds=[wrun_A]` while export contains `[wrun_A,wrun_B]`, or omits `canaryRunId`, passes producer hash+syntax check and assembles.
Impact: producer reports verified/assembles artifact final rescan must refuse; misleading ready. Fail-closed at final, but early gate weaker than `1196-1199` comment promises. Same pattern: producer `repositoryPath:215-227` lacks verifier `repositoryFile:73-92` absolute-path reject.
Fix: at source boundary parse export JSON and require set-equality `expectedRunIds` vs `workflowHistory.runIds` + `canaryRunId` membership; align absolute-path reject or correct comment to document layered intent.

P2-3 — Intermediate contract kind too weak:
File/line: `packages/application/src/one-a-3b-release-evidence.ts:230,318-319` + `produce-1a3b-g1-evidence.ts:1498-1514`.
Trigger: `expectedRunIds:[123]` or `["bad-id"]` passes `verifyOneA3bG1EvidenceArtifact` (`non-empty-array` only), so producer assembled-artifact check passes; only final regex/uniqueness catches.
Impact: weakens defense-in-depth, late detection.
Fix: tighten to `non-empty-string-array` minimum, ideally run-id pattern + uniqueness mirroring producer/final.

P2-4 — New producer validation untested:
File/line: `tests/one-a-3b-release-evidence.test.ts:519-615` covers `evidenceArtifactValue` + final throws, never `parseSourceEvidence` hash-mismatch/missing-values/duplicate/bad-runIds paths (`produce-1a3b-g1-evidence.ts:1200-1239`).
Trigger: future break in source-boundary errors goes undetected.
Fix: add coverage for source-boundary rejections via exported helper or CLI fixture.

Hypothesis, not flagged: `buildG1ReleaseIdentityFingerprint:614-663,1298-1315` omits `catalogPath` — not exploitable because `fixture.fingerprint` + outer `manifestFingerprint:1327-1342` still bind tamper; including it conditionally would preserve legacy and strengthen identity but not required for safety. Unknown fixture keys similarly bound by outer hash, ignored by inner — no fail-open.

Verification limits/evidence gap — ask Codex to provide:

* Full regression logs; supplied only focused `vitest two files --maxWorkers=2 22/22 410ms` + `typecheck source/tools/all6workspaces exit0`. No full suite.
* Fresh freeze/revalidate with new code: cited Provider4/4, Validator6/6, precision6/6, Continuation18/18 are prior frozen544, not new-code evidence.
* Real final `verifyHostedCanaryArtifact` rescan on newly assembled G1 artifact + producer rejection logs for tampered/missing values and bad runIds. Worker `47/47` not repeated at root; wrapper `blocked/error null` infers no deployment.

