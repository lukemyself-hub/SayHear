# PR approval v5 browser channel

Status: implemented, installed on this machine, and delivered as source on 2026-10-14.
The browser channel shipped inside the integrated controller as policy
`sayhear-pr-review-gate:v6` with report v4; this file records the v5-era plan that
started it.
Base: d73f07d48f3e4e8a605c9da2f7a0dddf79e3ab91, rebased onto
26a4130763000ca618178d375ac27e29f01784a9 for delivery.

## Contract

- PRs authored by `luke-agents` (id 342173548, User) use a current-head `APPROVED`
  GitHub review by Luke (`lukemyself-hub`, id 236989142, User). No root fallback.
- Historical PRs authored by `lukemyself-hub` keep the administrator-installed root
  authorization channel. Unknown authors get no human authorization.
- Bind the authenticated reviewer, review id, head, full diff digest, all Issue
  requirements, the protected path list, and the reviewed Validate workflow blob.
- Freeze the binding before approval. Later requirement changes cannot reuse an older
  approval. Dismissal or a newer non-approval review revokes it.
- Exclude approval reviews from requirement digests. Include inline review comments.
- Existing CI, production, privacy, migration, pause, Issue lifecycle, serial merge,
  and keep-open gates stay in force.
- Keep the then-current report schema; policy becomes `sayhear-pr-review-gate:v5`.
  Delivery moved both forward: report v4 with policy v6, once the migration
  evidence gate and the pre-merge deferrals were integrated.

## Throughput checkpoint

- Blocking first steps: inspect installed status, main baseline, documentation, and
  two independent designs before code.
- Independent workstreams: one owner for the coupled policy/controller/tests; parent
  owns delivery artifacts after that owner finishes.
- Shared mutable state: isolated managed worktree; original checkout is untouched.
  Receipts need authentication and atomic publication.
- Smallest safe decomposition: one implementation owner avoids two competing
  definitions of authorization across evidence, evaluation, and completion.

## Chosen design

Two ownerless options were considered: (a) a per-PR signed epoch state in its own
module, and (b) controller-local state plus a frozen context blob.

Chosen: (a). `scripts/pr-approval/browser-approval.ts` holds the whole browser
authorization rule set: pinned identities, the immutable context, the signed challenge,
the review watermark, the receipt, and the read-time revocation. The shared signed-store
protection moved to `scripts/pr-approval/signed-store.ts`, so browser receipts reuse the
same filesystem protections as completion records instead of a second copy. The
controller only derives the current context, freezes it in `readSnapshot`, and turns the
receipt into one `HumanReviewBinding` that both `collectEvidence` and `evaluateSnapshot`
read. Channel selection is `authorizationChannel(author)`, so a root record never fills
the browser channel.

Browser merges use an immediate pinned merge only. Deferred auto-merge stays a root-
channel behavior.

## Checklist

- [x] Ground subsystem and compare two designs.
- [x] Implement named authorization and immutable receipt model.
- [x] Verify focused tests, both TypeScript projects, and bundled tests.
- [x] Independent Standards and Spec reviews; fix blocking findings.
- [x] Generate installation helper and delivery record.
- [ ] Update automation memory with exact paths and installation state. Owner: parent.
- [x] Rebase into small, ordered commits.
- [x] Open PR.

## Results

- `tests/pr-approval-browser-approval.test.ts` adds 31 boundary and regression tests:
  freeze-then-approve ordering, same-second rejection, clock-skew watermark, context
  change and head-only sync denial, non-revival after restore, revocation, identity
  spoof, root fallback refusal, inline-comment inclusion with top-level review
  exclusion, workflow freeze without CI, signing, tamper, symlink, restart, deletion,
  v4 legacy projection, and post-merge dismissal.
- Source suites: 209 passed. Bundled suites over the built controller: 209 passed.
- `tsc --noEmit -p tsconfig.json` and `-p tsconfig.g1-tools.json` both pass.
- Exact bundle, source-tree fingerprint, and Node hashes live in
  `.audit/pr-approval-v5-tests/verification.json`. They are not repeated here: this
  file is inside the fingerprinted source tree, so inlining a hash would stale it.
- Evidence directory: `.audit/pr-approval-v5-tests/`.

## Residual limits

- The final live read and the GitHub merge request cannot be one atomic step. A
  dismissal inside that window can still let an already-authorized App approval carry
  the merge. Immediate merge plus the post-merge recheck narrows the window; it cannot
  close it.
- No bundled test exercises real GitHub App authentication, OAuth, or a hosted merge.
  Those stay unverified until the parent installs the bundle.
- The install path, root config, and current Node runtime are the parent's to verify.
- The browser-approval resume path re-issues the pinned merge without re-checking the
  serial-merge flag; it only moves a merge that already passed that gate and has a
  durable intent, and it re-reads Luke's live approval first.
- An ordinary agent PR that does not touch a protected path carries an `app`-channel
  completion record when no browser receipt is bound, so a lost merge response is
  recovered by confirming the merge, not by re-issuing it, and an unconfirmed record
  escalates to `needs_attention` after the retry budget. That matches the pre-v5 owner
  channel. A `needs_attention` record stalls every later scan and submission until a
  maintainer clears it; there is no clearing command yet.
- Requirement projection is fail-closed: an unrecognised policy version throws instead
  of falling back to the legacy review-inclusive digest.
