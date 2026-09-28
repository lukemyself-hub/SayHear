# G1 Release — Remaining Blockers

Status: **G1 is not ready to switch.** This is the state as of **2026-09-28**
after the #252 diagnosis, the budget fix, and the holdout catalog.

Evidence base: `docs/plans/issue-252-response-diagnosis.md` (executed
2026-09-28), tracked issues #250, #251, #252, #254.

## 0. What changed since the last status document

`docs/plans/g1-only-release-status.md` (2026-09-27) closed with "当前状态：
**代码已就绪，门禁全红，上线未开始**". Two of its open questions are now
answered, and one blocker has moved from "unproven hypothesis" to "proven and
fixed":

| Previous state | Now |
| --- | --- |
| Budget insufficiency was "当前最强推断，尚未证明每一例都同源" | **Proven.** 100% of failures, Provider-reported, zero parse or schema causes |
| Output budget 4000 | **8000**, measured: 4000 → 0/7, 6000 → 6/7, 8000 → 7/7 |
| Response failures recorded as one `schema_incompatible` code | **Four content-free causes** plus token accounting for successful and failed calls |
| 18-case catalog unused | **Spent** on diagnosis; a fresh holdout catalog is authored |

## 1. Blocked, with the specific reason

### B1 — Production configuration version and egress policy (release wiring)

**Blocked. Requires a migration.**

`model_role_configurations` has `PRIMARY KEY (role, config_version)`, and
`bindActiveG1Release` compares `parameter_snapshot` on conflict, throwing
`Immutable G1 configuration for <role> conflicts with the release manifest.`

Consequence: rolling out 8000 tokens **cannot** reuse
`narrative.validate:g1-release:v1`, which production already holds at 4000.
The guard is correct — it fails loudly rather than silently keeping the old
budget — but it means activation will refuse until all of these move together:

- a new `configVersion`, e.g. `narrative.validate:g1-release:v2`
- a new `providerPolicyVersion`, e.g. `deepseek-narrative.validate-egress:g1-release:v2`
- a new `rolloutPin`, with v1 retained as the rollback pin (ADR-0132)
- a new migration registering the new egress policy version, since
  `provider_egress_policy_versions.model_config_version` has no foreign key and
  must be declared explicitly
- `roleConfigurationsFromF3` in `scripts/produce-1a3b-g1-evidence.ts`, which
  currently **hardcodes** `configVersion: \`${role}:g1-release:v1\``,
  `providerPolicyVersion: \`${provider}-${role}-egress:g1-release:v1\`` and
  `rolloutPin: \`${role}-g1-release-pin:v1\`` — it will emit a v1 identity for a
  v2 configuration until changed

This is deliberately **not done** in this round. Changing production before
the holdout passes would roll out a configuration with no qualifying evidence,
which is the failure mode #252 was opened to close.

### B2 — Holdout acceptance run not executed

**Blocked on B4 (below) and on the run itself.**

Not yet run: the 18-case holdout, and the 6 clean-draft precision set. Both
must be captured at the new `1a3b-f3-pins:v2` pin on the exact release commit,
saving raw typed output, hashes, configuration, and the new error
classification plus per-case token usage.

### B3 — Luke's per-case adjudication

**Blocked. Human only.**

All 18 cases must be adjudicated individually by Luke. The machine verdicts
are advisory. ADR-0139 allows at most a 10% calibration miss (1 of 18);
precision false-blocking is zero-tolerance. The 6 precision drafts must
complete with zero blocking findings.

### B4 — ~~The 6 precision clean drafts are hardcoded and already spent~~ **RESOLVED in `f47e49d`**

`PRECISION_DRAFTS` was a hardcoded array in
`eval/continuation-acceptance-1a3b/run-validator-capture.ts` citing
`syn-claim-validator-en/zh/mix` — claim IDs from the **spent** catalog.
Running `--precision` against the new holdout would have silently reused the
spent clean drafts, disqualifying the precision half of the acceptance.

The capture now prefers `precisionDrafts` from the catalog when present and
falls back to the built-in set otherwise, and the holdout supplies six clean
drafts over its own claims. `verifyFixtureCatalog` rejects a supplied set that
is not six unique, non-empty drafts citing claims that resolve inside the same
catalog.

`fixtures.json` was deliberately left byte-identical: `buildManifest` hashes
the catalog bytes into the release fingerprint, so editing the spent catalog
would have invalidated evidence already produced against it.

### B5 — Holdout fixture difficulty has not been reviewed

**Blocked. Needs Luke's judgement.**

The holdout catalog was authored by the agent on 2026-09-28. It follows the
ADR-0139 grid exactly (3 language variants × 4 Bio + 2 Reflection, all six
dangerous-error classes) on a deliberately different fictional domain, and a
structural check confirms zero shared draft text and zero shared source claims
with the spent catalog.

But the agent that authored it already knew which error classes exhausted the
budget (`bio/contradiction` and `bio/unsupported` dominated). If those classes
were authored easier than the incumbent's, a pass would be uninformative.
**Luke must review difficulty before this catalog counts as a holdout.** The
zero-false-blocking gate and per-case adjudication are the intended controls,
but they are downstream of this review.

### B6 — Full release evidence regeneration

**Blocked on B1–B5.**

All 12 evidence sources must be regenerated and bound to a new exact-main
commit. The prior evidence (commit `a689449`, bound to `6b50dda`) cannot
authorize new code. This session's commits are on `codex/g1-release-status`,
which is **not `main`** — the branch must be reconciled and `main` advanced
before a manifest can name it.

Known constraint: `build-1a3b-g1-release-manifest.ts` refuses a dirty working
tree and requires `gitCommit === HEAD`, so the manifest can only be built at
the final commit. The producer writes `cutoverState: "disabled"` while
`activate-1a3b-g1.ts` requires `status` and `cutoverState` both `active`, so
the final switch is a deliberate human action.

### B7 — Hosted checks and recovery gates

**Blocked. Needs authorization and a live hosted-readonly connection.**

Hosted workflow canary, hosted export scan, Full Purge and restore drills,
pre-switch production G2 read-only audit, and rollback rehearsal. ADR-0141
requires inspecting production G2 pins and row counts read-only before
switching, and retaining G2 read/purge paths if real data exists. The status
document records a locally configured hosted-readonly connection; its current
validity is unverified and no authorization has been given to touch production
in this session.

### B8 — Non-determinism is uncharacterized

**Blocked on a product decision.**

The same pin with `temperature: 0` produced 4 and 7 failures across two runs,
over a largely different case set; 8 of 18 cases failed at least once (44%).
The Provider does not honour `temperature: 0` for reasoning spend. A single
successful run is therefore not evidence of determinism, and it is undecided
whether repeated runs are required for the gate. Tracked in #254.

## 2. Not blocked

- Four-role G1 scope, plain Memory Recall, Inspector, and Full Purge coverage
  are unchanged; no G2 restoration.
- `pnpm check:boundaries`, `pnpm check:purge-surfaces`, `pnpm typecheck`,
  `pnpm build`, and the full 1304-test suite are green on the current commits.
- Conversation pipeline fixture bug (memory-material claim) is fixed and
  reported; not a release blocker.
- #253 is merged and the #249 tree is in `main` via `e78073e`.

## 3. Recommended order

1. **B5** — Luke reviews holdout difficulty.
2. **B2/B3** — run the holdout at `1a3b-f3-pins:v2` on the release commit, then
   adjudicate all 18 plus the precision 6.
3. **B8** — decide whether repeated runs are required, from the holdout data.
4. Reconcile `main`, then **B1** — mint the v2 config, provider policy, and
   rollout pin, with a migration and the evidence-producer change.
5. **B6** — regenerate all 12 evidence sources and freeze the manifest.
6. **B7** — hosted checks, purge/restore drills, rollback rehearsal.
7. Human switches `cutoverState` to `active` and runs `release:g1:activate`.
8. #251 — the seven-day single-Owner real-data evaluation.

## 4. Known limitations of this document

- No claim here is backed by a holdout run; none has happened.
- The 8000 margin is **unmeasured**. 8000 cleared every case that had failed,
  but successful-call token usage was not recorded at the time, so "enough"
  cannot be distinguished from "barely held". The usage recording added in
  `614279d` fixes this for the holdout run, which will finally produce the
  number.
- `docs/plans/issue-252-response-diagnosis.md` caveat 1 still stands: the
  second 4000-token report is bound to the wrong commit and must not be
  promoted into a release manifest.
- Diagnostic artifacts are deliberately untracked
  (`.git/info/exclude`, local only), including the mis-bound report.
