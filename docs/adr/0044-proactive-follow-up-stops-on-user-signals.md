---
status: accepted
date: 2026-07-26
---

# Proactive Follow-Up Stops on User Signals

SayHear may use at most one Proactive Memory Follow-up in each Continuous
Exchange, with no quota requiring one. Greetings, open-ended starts, and
natural pauses may admit a target. A direct task, substantive current topic,
urgent need, or high-risk signal admits none, even after SayHear completes the
current response. `current_request_requires_focus=true` also rejects selection.
A null, stale, current-Event-unbound, or below-policy-confidence value fails
closed; `false` passes only this gate and does not require a follow-up.

The candidate set reuses the existing Memory path instead of adding a hidden
scan over all Memory. It combines every currently eligible Open Loop with
deduplicated ClaimVersions selected or explicitly matched by the current Person
Portrait and query-retrieval run after their trust fences. A target the User
has already raised in the current Continuous Exchange belongs to normal
conversation, and an Open Loop first formed from the current User Event cannot
be used proactively in that Turn.

The target must be active or open, unexpired, uncontested, non-dormant, outside
all Forget fences, and currently eligible. A short response, evasion, refusal,
or topic change suppresses proactive follow-up for that target. Suppression
uses a versioned, escalating policy rather than treating every signal as a
permanent refusal. `topic_changed` cools down for 1, then 7, then 30 local
calendar days and becomes non-time-releasable on the fourth signal.
`short_response` cools down for 7, then 30 days and becomes non-time-releasable
on the third. A first `evaded` cools down for 30 days and the second becomes
non-time-releasable. `refused` and `ambiguous_closure` never release with time.
Expiry or terminal state still wins over any cooldown.

Cooldown completion restores eligibility only; it does not require selection.
An independent, uniquely resolved User reopening, materially new direct User
Evidence that advances an eligible target, or explicit target-specific
permission clears the soft-signal count for later Turns. Model confidence,
ordinary Version or policy churn, index or rendering rebuilds, technical Entity
repair, and bare Correction, Forget, or Reversal control do not. A general
invitation to ask questions releases only the exchange-wide Curiosity Stop
Signal, not target suppression.
Sensitive topics are not categorically banned, but require direct User
Evidence and gentle framing that allows no answer. These gates make remembered
care possible without quotas, interruption, or repeated probing.

A selected target may be used through one natural question or one non-question
expression of care. Either form counts as the exchange's single Proactive
Memory Follow-up use. A proactive question shares the response-wide one-question
limit with an ordinary Follow-up Question. When the main response already asks
an ordinary follow-up, SayHear emits no proactive use; it cannot append a
statement as a loophole.

The selector chooses only the target. The Conversation Generator chooses the
expression form under a versioned Prompt and Policy: an Open Loop normally
invites a concise update question, while a Memory Claim defaults to an
acknowledgment unless its Evidence supports a concrete answerable development.
An AI Impression cannot invent a recent similar event to manufacture a
question. V1 sets no question-rate quota or mechanical alternation; typed form,
trajectory metrics, and Internal Owner blind judgment provide the evidence for
a later policy change.

Selection policy v1 uses two explainable lexicographic profiles, not a model
salience score or weighted total. Both profiles rank non-sensitive targets
before sensitive ones. Greetings and open-ended starts rank Open Loops by
expected time before Memory Claims. Natural pauses rank Memory Claims by the
existing Person Portrait or retrieval order before Open Loops. Within an
otherwise equal tier, a never-used target wins, then the least recently used,
then Evidence time and stable ID. This policy is versioned so Inspector evidence
and later blind comparison can replace it without rewriting historical runs.

Selection is not use. The Generator may return a typed target reference,
expression kind, and final-text locator, but only the atomic commit of a
Complete Assistant Response may persist the Assistant Event, typed use, and
exchange usage marker. Interrupted output, failed Attempts, and uncommitted
model claims consume nothing; Retry recompiles instead of inheriting them.

After a committed use, a model may propose `short_response`, `evaded`,
`refused`, or `topic_changed` against the next User Event and the exact use.
Deterministic code validates the owner, event order, target Version, and content
locator before appending suppression state. A brief complete answer still
suppresses future proactive use; ignoring the follow-up while continuing
elsewhere is `topic_changed`. A blanket request to stop questions also creates
the exchange-wide Curiosity Stop Signal. Until the response has one settled
disposition, that target fails closed rather than risking another prompt.

Concurrent selection uses one durable, Command-scoped reservation per User,
Daily Session, and Continuous Exchange. The reservation does not consume use
or suppress its target. It has no wall-clock lease that another live Command
can steal; only Command terminal state or reconciliation may release an
abandoned reservation. The Generator returns any proactive expression as an
isolated optional segment. The main response may stream, but the segment stays
hidden until its reservation, pinned target Version, expiry, and trust fences
pass a final pre-display check. Stale or losing segments are omitted, and the
main response remains valid.

The combined selector requires a complete current view of every enabled Open
Loop and Memory candidate lane. If either lane, its watermark, reservation, or
authoritative selection manifest fails, the selector returns no target while
the base conversation continues. It never substitutes the healthy lane or a
prior-turn cache because either would silently change the intended ordering.
An unsettled response disposition blocks only its target. Failed suppression
or release commits keep that target closed. Inspector display failure does not
block conversation, but failure to commit the authoritative manifest does.

One versioned bundle pins the opportunity, selection, suppression, typed-use,
expression, and Inspector reason-code components used by a run. A component
change publishes both a new component Version and a new bundle Version; old
CompiledContexts, reservations, uses, and dispositions are never reinterpreted.
Internal Core switches directly to one complete bundle without dual writes,
shadow selection, or runtime A/B. Before a prior selector exists, rollback is a
deployment rollback rather than a permanent feature flag.

Absence of a `ProactiveFollowupState` row means `never_suppressed`, so this gate
passes without a backfill or pre-created eligible row. The manifest records a
null state Version and the explicit reason. A committed use does not create an
eligible state row. The first suppression lazily creates the logical state and
its suppressed Version; later releases append eligible Versions.

The ordinary Conversation Decision generates the main response without a
proactive target while current-Event DialogueState is produced concurrently.
At main-response completion, the harness checks that state once without extra
waiting. Missing, stale, low-confidence, or mismatched state yields no target
with `state_not_ready_at_main_completion`. If the state passes and the main
response contains no ordinary question, selection and reservation may create a
separate, tools-disabled Proactive Follow-up Segment Command. That Command can
only render the isolated segment from the frozen main response and target. Its
failure or stale result leaves the main response intact. A successful result is
combined into one Complete Assistant Response; the Assistant Event references
both Commands and the typed use references the Segment Command. Retry starts a
new main Command and inherits no old state, reservation, or segment.
