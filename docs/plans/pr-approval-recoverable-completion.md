# Recoverable PR completion for Issue #339

Status is implemented and locally verified. Protected installation and independent PR approval remain separate acceptance gates.

The execution contract is [Luke's decision](https://github.com/lukemyself-hub/SayHear/issues/339#issuecomment-6154083186).

## Evidence and source ownership

The repository controller is the only maintained implementation. The starting main commit is `b7fac60d3111726616c571840f33126d9a4b6e41`.
The read-only installed bundle snapshot has SHA-256 `ebfa3d099f916b7109a58283bc783b83de570a5644c305d5378684ff697392bc`.
Its reconciliation compares `head.repo.id`, reviewed head, `main`, merge state, merge SHA, App approval, and a requirement digest.
The historical immediate GitHub response for PR #338 is unavailable. This work does not establish which predicate failed historically.

The installed bundle already contains multi-Issue delivery, keep-open exclusions, tree/blob diff evidence, and stale-base handoff.
Luke authorized publishing the corresponding existing uncommitted source, tests, and documentation from the primary checkout as this PR's implementation basis.
The primary checkout is preserved. This publication prevents replacing the installed bundle with a controller that loses these behaviors.

The deterministic fixture changes PR and Issue `updated_at` after closure and proves the approved v4 requirement digest stays stable.
The metadata-drift hypothesis was rejected by this test.
Recovery preserves the existing requirement digest, which binds titles, bodies, references, exclusions, and human discussion while excluding workflow metadata.
The pre-merge exact-head/base gates retain their existing meaning.

## State and trust

The controller persists a signed intent before requesting merge or auto-merge.
The intent binds repository and base repository IDs, PR number and node ID, reviewed head/base, App and reviewer IDs, review ID, policy, approved requirement digest, and eligible Issue numbers.

Receipts live at the current user's `Library/Application Support/SayHear/PRApproval/completions` directory.
The directory and files require owner-only permissions and regular, non-symlink paths.
RSA signatures use the existing App private key inside the trusted controller, and verification uses the corresponding public key after protected App identity validation.
The user-owned storage cannot authorize recovery without a valid signature.
No key is written into receipts, artifacts, logs, model processes, or checkout files.
The trusted launchers and App permission boundary are unchanged.

A signature failure, unavailable key, changed App identity, or rotated key blocks recovery and later merges.
Retain the receipt for maintainer investigation. Key rotation does not silently re-sign old receipts or discard unfinished state.
Legacy checkout-owned pending reports are not imported as authority.

The phases are `merge_unconfirmed`, `issues_pending`, `complete`, and `needs_attention`.
Atomic replacement follows a file fsync and a directory fsync. Completed records remain as replay protection.
The existing repository lock serializes submit and scan. Recovery checks the lock directory owner and permissions, and refuses symlinks.
A PID that is alive or cannot be checked keeps the lock. Only a definitely dead PID permits stale-owner removal.

Recovery performs reads and verified Issue completion. It never submits reviews or requests merge.
Startup submit and scan recover pending records before other work. Unresolved or mismatched operations block later merges across the repository.
Prepare reports pending state without executing completion writes.

## Retry and Issue behavior

A command performs at most five confirmation attempts with exponential backoff and jitter, and waits at most 60 seconds.
Retry-After and exhausted GitHub rate limits defer the operation beyond the command window when necessary.
The record retains attempt count, next retry time, safe diagnostic reason, and confirmed merge SHA.
Ten automatic execution cycles exhaust recovery and retain `needs_attention`.
The merge result remains distinct from incomplete Issue completion in the record and status output.

Complete identity mismatches stop immediately. Missing fields, network failures, and contradictory transient state remain pending.
Confirmation requires the bound PR, repository, head, base branch, closed merged state, merge SHA, and live App review.
The pinned API version omits `merge_commit_sha` and GitHub removes the pull request merge ref after merge,
so confirmation takes the merge SHA from the pull request payload when present and otherwise from the
`merged` timeline event that GitHub records for the same merge commit.
The current main SHA may advance after merge. The pre-merge reviewed base SHA remains pinned in the approval identity.

Issue closure and label deletion use the existing per-Issue API operations.
Closed Issues still lose stale workflow labels. Category labels and concurrent unrelated labels are preserved.
Partial writes, lost responses, and failed final reads retain `issues_pending` and retry only missing actions.
Per-Issue aggregation preserves the largest Retry-After across failed targets while attempting every eligible Issue once.
Durable receipts retain the fixed reason `completion_issue_updates_incomplete`; detailed per-Issue errors remain in the thrown message.
The composition regression drives `recoverCompletion` through actual Issue label cleanup and proves long Retry-After values defer the next command without short retries.
No completion comment is sent, so recovery cannot duplicate completion comments.

## Build, verification, installation, and rollback

Run `pnpm pr:approval:build` on Apple Silicon macOS with Node 24.18.0 and the frozen pnpm lockfile.
The build manifest records source commit, hashes of every esbuild input, Node and esbuild versions, clang version, bundle hash, runtime hash, and launcher hashes.
Run `node scripts/verify-pr-approval-bundle.mjs` to execute the same controller, completion, diff, and gate fixtures against the actual bundle.
The verifier checks the artifact hash and source/capability identity before executing fixtures.
All controller, completion, diff, review-gate, and release-validation imports in those four suites resolve to the same bundle.
The controller re-exports the public fixture entrypoints, so the reported bundle test count does not mix source and bundle implementations.

Install only the independently reviewed artifact through the existing administrator-approved protected installation process.
The destination is `/Library/Application Support/SayHear/PRApproval/controller.mjs`.
Preserve the current root-owned bundle as rollback material with its hash before replacement.
Do not change config, Keychain entries, App permissions, branch protection, Node, or launchers merely to install this source change.

After installation, call the fixed `pr-approval-status` launcher.
Compare `controllerSha256` with the manifest and `build.sourceCommit` with the reviewed source commit.
Require completion version `sayhear-pr-completion:v1`, policy `sayhear-pr-review-gate:v4`, diff version `sayhear-pr-diff:v2`, and base handoff version `sayhear-pr-base-sync:v1`.
Run isolated fixtures against the installed bundle without calling main or using App credentials.
A status response proves installation identity and read-only authentication, not a real production merge.

If rollback is needed, restore the saved protected bundle through the same approved administrator process.
Do not delete signed receipts. The old controller cannot consume them and must not resume new merges while any signed operation is unresolved.
Resolve those operations with the reviewed new controller or explicit maintainer reconciliation before using the old merge path.
