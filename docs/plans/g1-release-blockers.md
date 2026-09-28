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

**Next. Requires a migration. No longer gated on the holdout.**

`model_role_configurations` has `PRIMARY KEY (role, config_version)`, and
`bindActiveG1Release` compares `parameter_snapshot` on conflict, throwing
`Immutable G1 configuration for <role> conflicts with the release manifest.`

Consequence: rolling out 8000 tokens **cannot** reuse
`narrative.validate:g1-release:v1`, which production already holds at 4000.
The guard is correct — it fails loudly rather than silently keeping the old
budget — but activation **cannot rotate a live role**, which is the part that
blocks a smooth release:

- `model_role_rollout_pins_one_active_idx` is a partial unique index on `role`
  where `status = 'active'`, so only one pin per role may be active.
- `bindActiveG1Release` compares the requested pin set against the currently
  active set and throws `G1 activation refuses a partial or conflicting active
  rollout pin set` on any difference, including a single role moving to a new
  pin. Mixed-version active sets are not representable.
- `revokeActiveRolloutPins` — the only path that sets `status = 'revoked'` —
  requires `hasExactG1RoleSet`, so it always revokes **all four** roles, and
  matches on `release_fingerprint`.

**Consequence: there is no forward path.** Rolling a new `narrative.validate`
config over a live deployment requires revoking the complete four-role G1 set
and re-activating all four with the new versions. The budget fix is therefore
a rollback-and-relaunch, not an in-place bump, and the rehearsal in B7 is not
optional bookkeeping — it is the only rehearsal that exercises the real
procedure.

Activation will refuse until all of these move together:

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
- `tests/system/g1-release-activation.system.test.ts`, which builds the same
  three identities in its own helper

### B1a — The version number to mint is unverified

**Blocked. Needs a production read-only check.**

`docs/plans/g1-only-release-status.md` records the live active pins as "G1 v2"
for the four roles. That phrase is ambiguous in a way that matters: it may be a
human label for a deployment iteration, or it may be the literal config
version. This document previously asserted that production "already holds 4000
at v1" — that was an inference, not a verified read.

If the live config version is already `narrative.validate:g1-release:v2`, then
minting v2 collides with it and the immutability guard throws on the first
activation attempt. The version to mint depends on the answer, so it must be
read from `model_role_configurations` before the migration is written, not
after.

The hosted read-only connection used on 2026-09-27 inspected only pins and row
counts and never read configuration identities, so the answer is not already
on file.

This was deliberately held back while the holdout was treated as a
precondition. Luke's test-data decision (see §2) moves it ahead of the holdout:
the wiring can be built and verified now against the spent 18, and the holdout
then certifies the finished configuration rather than gating its construction.

### B2 — Final acceptance run not executed

**Blocked on the run itself. This is the last gate, not a precondition.**

The 18-case holdout and the 6 clean-draft precision set are **sealed**. They run
once, at final acceptance, on the exact release commit at
`1a3b-f3-pins:v2`, saving raw typed output, hashes, configuration, the new error
classification, and per-case token usage.

Per Luke's decision (2026-09-28), the holdout is not consumed by any
intermediate testing. Everything before this run — the v2 wiring, evidence
regeneration, hosted checks — is verified against the **spent** 18-case catalog
instead. See §Test data usage rule.

### B3 — Luke's per-case adjudication

**Blocked. Human only.**

All 18 cases must be adjudicated individually by Luke. The machine verdicts
are advisory. ADR-0139 allows at most a 10% calibration miss (1 of 18);
precision false-blocking is zero-tolerance. The 6 precision drafts must
complete with zero blocking findings.

### B5 — ~~Holdout fixture difficulty needs review~~ **CANCELLED by Luke, 2026-09-28**

Luke's decision: the holdout does not need to be hard. The objective is a
smooth release, not completeness on edge cases. The agent-authored fixtures
stand as written, and their difficulty is not a gate.

The original concern was that the agent already knew `bio/contradiction` and
`bio/unsupported` exhausted the budget, and might have authored them easier than
the incumbent's. That concern is withdrawn as a blocker. The controls that
still apply are unchanged and still meaningful: zero-tolerance on precision
false-blocking, per-case adjudication by Luke, and the 10% calibration cap.

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

Because the holdout is sealed (§2), this must be characterised on the spent 18
using repeat runs, together with the 8000 headroom measurement that successful-
call usage recording now makes possible. It is step 2 of the recommended order.

## 2. Test data usage rule

Decided by Luke on 2026-09-28, mid-#252:

> Holdout 只有在正式跑最终验收的时候才需要，任何中间过程的测试，都用之前的 18 例旧 case 来做，避免划掉这个新 holdout。

| Data | Allowed for | Forbidden for |
| --- | --- | --- |
| `fixtures.json` (spent, 18 cases) | All intermediate and diagnostic runs | Claiming acceptance evidence |
| `holdout/fixtures.json` (fresh, 18 + 6) | The single final acceptance run | Any tuning, diagnosis, or regression check |

The holdout's value is that it was never looked at. One diagnostic run against
it converts it into tuning data and it can no longer certify the release, so it
stays sealed until the release is otherwise ready. The spent catalog is
unlimited and is spent already — it is the right instrument for every
intermediate question, including whether 8000 leaves headroom.

One consequence worth stating: because the holdout is sealed, the
non-determinism question (B8) must be characterised on the spent 18, not on
the holdout. A single acceptance run therefore cannot be treated as evidence of
determinism unless B8 is settled first.

## 3. Not blocked

- Four-role G1 scope, plain Memory Recall, Inspector, and Full Purge coverage
  are unchanged; no G2 restoration.
- `pnpm check:boundaries`, `pnpm check:purge-surfaces`, `pnpm typecheck`,
  `pnpm build`, and the full 1304-test suite are green on the current commits.
- Conversation pipeline fixture bug (memory-material claim) is fixed and
  reported; not a release blocker.
- #253 is merged and the #249 tree is in `main` via `e78073e`.

## 4. Recommended order

The objective is a smooth release. The holdout is the **last** gate, not a
precondition for the work below, so every intermediate step is verified against
the spent 18 cases.

1. **B1** — mint the v2 config, provider policy and rollout pin, with a
   migration and the evidence-producer change. Verify on the spent 18.
2. **B8** — characterise non-determinism on the spent 18 (repeat runs, and the
   8000 headroom now that successful-call usage is recorded). Decide whether
   repeated runs are required for the gate.
3. Reconcile `main` onto the release branch.
4. **B6** — regenerate all 12 evidence sources and freeze the manifest.
5. **B7** — hosted checks, purge/restore drills, rollback rehearsal.
6. **B2/B3** — the one and only holdout run at `1a3b-f3-pins:v2` on the frozen
   release commit, then Luke adjudicates all 18 plus the precision 6.
7. Human switches `cutoverState` to `active` and runs `release:g1:activate`.
8. #251 — the seven-day single-Owner real-data evaluation.

B5 is cancelled. B4 is resolved.

## 5. Known limitations of this document

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
