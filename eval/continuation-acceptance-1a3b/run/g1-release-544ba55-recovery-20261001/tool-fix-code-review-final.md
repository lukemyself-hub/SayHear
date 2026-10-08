Verdict: no remaining P1/P2 release blocker in the five owned files. Do not claim new Provider/deployed G1 complete.

Fixed confirmed:

* P2-1 fixed — `scripts/produce-1a3b-g1-evidence.ts:1961-1973` guards `main()` with `process.argv[1] + import.meta.url === pathToFileURL(resolve(...)).href`; import no longer touches `process.exitCode`. New `tests/one-a-3b-release-evidence.test.ts:~540` `spawnSync node --import tsx -e import(...) status 0` pins inertness.
* P2-3 fixed — `packages/application/src/one-a-3b-release-evidence.ts:230` is now `non-empty-string-array`, handled at `:304`; rejects `[7]/[""]` at intermediate artifact check.
* P2-2 honest — `scripts/produce-1a3b-g1-evidence.ts:1197-1200,1239` now states syntax/uniqueness only, `regex does not prove completeness`, error is `non-empty unique run-id list`. Layering is explicit; completeness stays with final `verifyHostedCanaryArtifact` exact-match gate.

Still correct, no action:

* AC-W01 contract retains both refs; `evidenceArtifactValue` copy loop carries them; dropping either still throws `lacks deployment…` / `values reference is missing` per new assembly test.
* Fixture `fixtureFingerprintSource` preserves no-path legacy identity, binds pinned `catalogPath`; builder/verifier share shape; swap/malformed `7` rejected.
* No semantic tuning/model switch/waiver expansion; scope stays five files.

Limits — did not execute tests:

* Rely on supplied: worker `23+47 passed`, prior root full `1413 passed` before new import test, root independent import `old report SHA unchanged/exitCode untouched`, new full root `currently running`.
* No new freeze/revalidate or deployment evidence; prior frozen544 is not new-code evidence. Release still requires refreeze + full regression + real final rescan before G1.

