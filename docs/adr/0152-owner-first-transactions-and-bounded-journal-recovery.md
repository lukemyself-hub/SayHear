---
status: accepted
date: 2026-10-13
---

# Owner-first transactions and bounded Journal recovery

Issues #340 and #341 confirm Owner-first locking, SQL-only transaction retries,
durable Journal recovery and an explicit failure state. Every transaction that
writes owner-scoped derived state acquires Owner, then Session/Aggregate, then
child records. Multi-owner scan transactions acquire Owner IDs in ascending order.
An unlocked ownership lookup only locates the Owner. The transaction rechecks
ownership, active status, data epoch and the applicable freshness policy.

Evidence freezes source rows in a short transaction and releases its connection
before Provider extraction. A short dispatch claim revalidates frozen sources and
epoch after Recovery Gate authorization, persists an owner-scoped attempt, and
excludes another running attempt for that Session/revision/policy/epoch.
A completed snapshot returns before any Provider call. A final transaction checks the frozen sources remain
current, active and unpurged under the same epoch. It publishes the snapshot,
Evidence and lineage atomically. A new user turn can advance the Session without
invalidating older source-valid Evidence. Journal publication still requires the
exact current source revision. Preparation never publishes an empty header.

SQL transactions retry `40P01` and `40001` at most three times, with 25 ms and
50 ms backoff after complete rollback. Provider calls remain outside this retry
boundary. `55P03` is a distinct lock timeout. `57014` is statement cancellation,
which does not alone prove lock contention. Infrastructure failures escape the
Workflow step after recording content-free recovery metadata.

Journal recovery counts durable attempts before Evidence or Journal Provider
work. There are at most three automatic attempts per command. A lease lasts at least five minutes and at least three configured Provider
deadlines plus one minute. Evidence sources run concurrently, followed by one
Journal draft call and one diagnostic call. Admission and publication both check
the live token, so a reclaimed worker cannot publish.
A failed attempt releases the lease and becomes due after one minute. The existing
Recovery Scan re-arms the original outbox only when the lease has expired or is
absent and the retry is due. Legacy retryable failures start at count zero.
A crashed final attempt or exhausted budget terminates as `needs_review` with
`retry_budget_exhausted`, no lease and no next retry, and a dead-lettered command.
Daily readiness can then settle the final failure. Normal running and retryable
commands still wait.

The Journal page displays a failed-generation notice and an authenticated,
same-origin retry action. The action only re-arms a current terminal failure,
rechecks epoch, revision and ownership, and resets its automatic budget once.
Concurrent requests converge through a terminal-state CAS. The original
conversation remains. Failure never becomes `insufficient_expression`.

Evidence Items keep one immutable locator identity and their original provenance
snapshot. Fast-path Event sequence and Journal Session revision can produce
different snapshot headers for the same source. The completed Evidence attempt for each Journal freeze
therefore records an explicit `frozen_evidence_item_ids` set. Readers use that
set, and Journal links retain each item's provenance snapshot. Reused locators
no longer leave the Journal snapshot empty. Header existence alone is not a
completed freeze.

Pending Evidence attempts carry direct Owner identity before any snapshot exists.
Full Purge resolves both that identity and older snapshot-linked rows whose new
columns remain NULL, preserving old-writer compatibility during deployment.
The migration backfills only new ownership metadata on existing linked attempts.
