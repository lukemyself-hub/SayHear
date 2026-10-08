## Independent read-only review — operator helpers preserve frozen `544ba55`

**Scope:** `544ba55` frozen source, prior G1/validator/precision/continuation evidence, plus the two supplied operator helper diffs. No edits, no shell, no test execution claimed. Tracked diff empty preserved.

**No deployment approved by this review.** Provider `completed`, validator `accepted`, hard-gate `passed`, hosted-canary pass do **not** equal hosted Episode/Reflection working or production active. Production G1 remains OFF, no active manifest.

### P1 — confirmed: frozen source bug remains, helper only works around it

**File:** `packages/application/src/one-a-3b-release-evidence.ts:209-219` vs `scripts/verify-1a3b-g1-evidence.ts:221-228` vs `scripts/produce-1a3b-g1-evidence.ts:1370,1547`

**Trigger:** `AC-W01` contract `requiredResultKeys: ["hosted","canaryRunId","deploymentId","exportArtifact"]` omits `expectedRunIds` + `canaryValuesArtifact`, while final `verifyHostedCanaryArtifact` requires both plus re-scans raw `exportArtifact`/`canaryValuesArtifact` refs for deployment, `wrun_*` pins, decrypted complete pages, six categories.

Producer loops only `contract.requiredResultKeys`, so every build drops the two fields, then builder fails `Hosted canary lacks deployment and complete run-set pins` even when `evidence-sources/ac-w01.json` already carries the real values matching the real `dpl_…` / `wrun_…` export.

**Impact:** Every future hosted canary needs the same manual assembler. Unauditable at scale.

**Fix required (follow-up, not in helpers):** add `expectedRunIds` + `canaryValuesArtifact` to `AC-W01.requiredResultKeys` + `resultFieldKinds`, make producer copy them, add regression test. No model change needed.

**This review explicitly states the source bug remains.** The helpers below are evidence correction, not a source fix.

> Evidence correction vs deployment source: neither helper touches the actual Vercel deployment, workflow runs, export bytes, or values bytes. They only create new local JSON (`ac-w01-final.json`, `g1-release-manifest-final-input.json` / `evidence-sources/ac-x04.json`) and re-run the frozen verifier against actual values.

### Helpers — no P1 fabrication found

**`AC-X04` helper — sound:**
replays frozen `verifySyntheticRunHardGates`, `canonicalJson(recomputed) === canonicalJson(rawReport)`, checks 18 continuation IDs, `capture.configId/arm === G1_ACCEPTANCE_HARD_GATE_CONFIG_ID` (= `continuation-incumbent-1a3a` per `protocol.ts:43`), `configurationFingerprint(pins,continuation,configId)`, catalog hash/version, pins hash, `HEAD` + `status --porcelain --untracked-files=no` tracked-clean, `checkedFixtureCount===18`, `failures.length===0`, `passed/applicable`. Reads raw bytes for `sha256`, never writes capture/raw, `wx` exclusive create. Derives `passed/confirmedHardFailures` from replay, nothing hand-greened. `verify-only` re-compares canonical source.

**`AC-W01` fields helper — sound as correction:**
clones `evidence/ac-w01.json`, copies only the two dropped actual references from `evidence-sources/ac-w01.json`, re-runs **same** frozen `verifyHostedCanaryArtifact` (full raw re-read/re-scan), hashes new bytes, updates only `AC-W01.artifactPath/artifactSha256` in a cloned manifest input, proves no other move via revert + `sameJson`. Originals never written, `wx` both files, fail-closed on any shared-key disagreement, lineage mismatch, `exactly-one-AC-W01`, hash/content drift, or verifier throw. `verify-only` re-checks hash, content, binding, and re-runs verifier. No `passed=true` invented; inherits already-validated pass.

Prior identity/pins/coverage still hold: `9e09…` fingerprint, `544ba55` clean, `deepseek-v4-flash` / `deepseek-flash` alias per ADR-0140, `v3/v3/v3/v5` + `v6` pins, narrative `10000 + reasoning.low`, 4/4 roles `completed` with command/attempt IDs + usage, validator 6/6, precision 6/6 `falseBlocks 0`, continuation 18/18 zero failures, probe `954ms response.completed`, 1411 same-SHA copies with original `19:35` context not a rerun.

### P2 — robustness / provenance (not blockers for this assembly)

1. **Helpers live outside frozen root** (`/private/tmp/…`, `~/.local/share/opencode/…`), untracked. Logic anchors to frozen verifier/protocol via `args.root` import + `HEAD` clean check, but helper bytes themselves need archiving + hash. Embedded `command`/`verification.command` with absolute tmp paths will not reproduce after tmp expiry — preserve helper content alongside evidence.
2. **Missing `mode:0o600`** on both `writeFileSync(...,{flag:"wx"})`. Prior capture/completion writers use `0o600`. Default `0644` is looser for canary/export-derived JSON.
3. **Narrow two-field copy.** Helper fixes only this release's two dropped keys. Any future contract addition needs the source fix above, not another helper.
4. **`status` vocabulary assumption.** `source.passed===true` + `dest.status==="passed"` held for this run (writer/verify-only exit 0 per root), but contract for those fields was not in attached scope. Failure mode is fail-closed reject, not false accept — confirm vocabulary in follow-up to avoid brittle coupling.

**Verification limits:** did not recompute hashes, did not read hosted export/values bytes, six categories, five probes, or `rawProviderError skipped` per ADR-0145 beyond helper logic; did not verify `dpl_…`/`wrun_…` IDs against live deployment; did not verify typecheck/build logs beyond copied test JSONs.
