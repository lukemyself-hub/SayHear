import { createHmac } from "node:crypto";

import type { OpenLoopId } from "@sayhear/domain";

import type {
  OpenLoopCapacityCandidate,
  OpenLoopClosurePlan,
  OpenLoopClosureProposal,
  OpenLoopFormationPlan,
  OpenLoopKind,
  OpenLoopProposal,
  OpenLoopTerminalStatus,
} from "./types";
import {
  MAX_CURRENT_OPEN_LOOPS_PER_OWNER,
  MAX_NEW_LOOPS_PER_EVENT,
  OPEN_LOOP_DEDUPE_FINGERPRINT_KEY_VERSION,
  isKindStatusPairValid,
  isOpenLoopKind,
} from "./types";
import {
  computeOpenLoopSchedule,
  isNearTermLexicalHit,
  validateExpectedWindow,
} from "./policy";

/**
 * Deterministic `open-loop-formation:v1` + `open-loop-closure:v1` core
 * (issue #204, SPEC 6, ADR-0042/0132). Pure functions only: `now` and all
 * live state are injected by the caller so every rule is replayable in unit
 * tests and stable under concurrent events.
 */

export type OpenLoopIdentityCandidate = Readonly<{
  openLoopId: OpenLoopId;
  kind: OpenLoopKind;
  canonicalClaimKey: string | null;
  expectedStartAt: string | null;
  expectedEndAt: string | null;
}>;

function timeExpressionWithSourceCue(
  expression: string | null | undefined,
  sourceUserText: string | undefined,
): string | null | undefined {
  if (!sourceUserText || !expression?.trim()) return expression;
  const phrase = expression.trim();
  const offset = sourceUserText.toLowerCase().indexOf(phrase.toLowerCase());
  if (offset < 0) return null;
  const preceding = sourceUserText.slice(Math.max(0, offset - 16), offset);
  const following = sourceUserText.slice(offset + phrase.length, offset + phrase.length + 8);
  if (/\b(?:by|before)\s*$/i.test(preceding) || /^(?:之前|以前|前|截止)/.test(following)) {
    return `by ${phrase}`;
  }
  return phrase;
}

function windowsCompatible(
  left: Readonly<{ startAt: string | null; endAt: string | null }>,
  right: Readonly<{ startAt: string | null; endAt: string | null }>,
): boolean {
  if (!left.startAt || !right.startAt) {
    return true;
  }
  const leftStart = new Date(left.startAt).getTime();
  const leftEnd = left.endAt ? new Date(left.endAt).getTime() : leftStart;
  const rightStart = new Date(right.startAt).getTime();
  const rightEnd = right.endAt ? new Date(right.endAt).getTime() : rightStart;
  if (
    Number.isNaN(leftStart) ||
    Number.isNaN(leftEnd) ||
    Number.isNaN(rightStart) ||
    Number.isNaN(rightEnd)
  ) {
    return false;
  }
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function explicitBindingTarget(
  proposal: OpenLoopProposal,
  candidates: readonly OpenLoopIdentityCandidate[],
): OpenLoopIdentityCandidate | null {
  if (!proposal.explicitLoopBinding) {
    return null;
  }
  return (
    candidates.find(
      (candidate) => candidate.openLoopId === proposal.explicitLoopBinding,
    ) ?? null
  );
}

function claimIdentityTarget(
  proposal: OpenLoopProposal,
  kind: OpenLoopKind,
  expectedStartAt: string | null,
  expectedEndAt: string | null,
  candidates: readonly OpenLoopIdentityCandidate[],
): OpenLoopIdentityCandidate | null {
  if (!proposal.canonicalClaimKey) {
    return null;
  }
  const matches = candidates.filter(
    (candidate) =>
      candidate.kind === kind &&
      candidate.canonicalClaimKey !== null &&
      candidate.canonicalClaimKey === proposal.canonicalClaimKey &&
      windowsCompatible(
        { startAt: expectedStartAt, endAt: expectedEndAt },
        {
          startAt: candidate.expectedStartAt,
          endAt: candidate.expectedEndAt,
        },
      ),
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/**
 * Formation gate order is fixed so identical inputs always produce identical
 * plans: kind -> non-task -> evidence -> anchor -> fabricated-date ->
 * window -> horizon -> identity.
 */
export function planOpenLoopFormation(input: Readonly<{
  proposal: OpenLoopProposal;
  evidenceCommittedAt: string;
  evidenceTimeZone: string;
  sourceUserText?: string;
  identityCandidates: readonly OpenLoopIdentityCandidate[];
}>): OpenLoopFormationPlan {
  const { proposal } = input;
  if (!isOpenLoopKind(proposal.kind)) {
    return { action: "skip", kind: null, reasonCode: "kind_invalid" };
  }
  const kind: OpenLoopKind = proposal.kind;
  // Dated tasks are rejected even with a date: a pending state needs an
  // independent reality event or external outcome, not an obligation.
  if (proposal.isTaskLike) {
    return { action: "skip", kind, reasonCode: "task_like_rejected" };
  }
  if (!proposal.evidenceItemId || !proposal.evidenceRevisionId) {
    return { action: "skip", kind, reasonCode: "evidence_missing" };
  }
  if (!proposal.hasRealAnchor) {
    return { action: "skip", kind, reasonCode: "no_real_anchor" };
  }
  const claimedWindow = proposal.expectedWindow ?? null;
  const sourceTimeExpression = timeExpressionWithSourceCue(
    proposal.userTimeExpression,
    input.sourceUserText,
  );
  if (claimedWindow?.precision === "date" && input.sourceUserText && !sourceTimeExpression) {
    return { action: "skip", kind, reasonCode: "no_real_anchor" };
  }
  const hasClaimedAnchor =
    claimedWindow !== null &&
    claimedWindow.startAt !== null &&
    claimedWindow.precision !== "approximate" &&
    claimedWindow.precision !== "unknown";
  // Fuzzy expressions outside the versioned allowlist must stay unanchored;
  // a claimed precise window built from one is a fabricated date. Digit-free
  // non-empty expressions are the fuzzy signal deterministic code can see;
  // precise expressions (with dates) and absent expressions carry no such
  // signal, so only the fuzzy case rejects here.
  if (hasClaimedAnchor && proposal.userTimeExpression) {
    const expression = proposal.userTimeExpression.trim();
    if (
      expression !== "" &&
      !/\d/.test(expression) &&
      !isNearTermLexicalHit(proposal.userTimeExpression)
    ) {
      return { action: "skip", kind, reasonCode: "no_real_anchor" };
    }
  }
  const validated = validateExpectedWindow({
    window: claimedWindow,
    kind,
    evidenceTimeZone: input.evidenceTimeZone,
  });
  if ("error" in validated) {
    return {
      action: "skip",
      kind,
      reasonCode:
        validated.error === "time_window_too_wide"
          ? "time_window_too_wide"
          : "no_real_anchor",
    };
  }
  const schedule = computeOpenLoopSchedule({
    kind,
    anchored: validated,
    evidenceCommittedAt: input.evidenceCommittedAt,
    evidenceTimeZone: input.evidenceTimeZone,
    userTimeExpression: sourceTimeExpression,
  });
  if ("error" in schedule) {
    return {
      action: "skip",
      kind,
      reasonCode:
        schedule.error === "horizon_exceeded"
          ? "horizon_exceeded"
          : "no_real_anchor",
    };
  }
  const expectedStartAt = validated.anchored ? validated.startAt : null;
  const expectedEndAt = validated.anchored ? validated.endAt : null;
  // Cross-Evidence logical identity is deliberately conservative: reuse needs
  // a unique explicit binding, or the same canonical Objective Claim with the
  // same kind and compatible time. Entity/Episode/similar text/time signals
  // only retrieve candidates and never authorize a merge. Ambiguity fails
  // closed without merging and without creating a possible duplicate.
  const explicit = explicitBindingTarget(proposal, input.identityCandidates);
  if (proposal.explicitLoopBinding) {
    if (explicit && explicit.kind === kind) {
      return {
        action: "reuse_loop",
        kind,
        openLoopId: explicit.openLoopId,
        expectedStartAt,
        expectedEndAt,
        precision: validated.anchored ? validated.precision : "unknown",
        timezone: validated.anchored ? validated.timezone : null,
        followupEligibleFromAt: schedule.followupEligibleFromAt,
        expiresAt: schedule.expiresAt,
        expirySource: schedule.expirySource,
      };
    }
    return { action: "skip", kind, reasonCode: "ambiguous_loop_identity" };
  }
  if (proposal.canonicalClaimKey) {
    const claimMatch = claimIdentityTarget(
      proposal,
      kind,
      expectedStartAt,
      expectedEndAt,
      input.identityCandidates,
    );
    if (claimMatch) {
      return {
        action: "reuse_loop",
        kind,
        openLoopId: claimMatch.openLoopId,
        expectedStartAt,
        expectedEndAt,
        precision: validated.anchored ? validated.precision : "unknown",
        timezone: validated.anchored ? validated.timezone : null,
        followupEligibleFromAt: schedule.followupEligibleFromAt,
        expiresAt: schedule.expiresAt,
        expirySource: schedule.expirySource,
      };
    }
    const sharesClaimKey = input.identityCandidates.some(
      (candidate) =>
        candidate.kind === kind &&
        candidate.canonicalClaimKey !== null &&
        candidate.canonicalClaimKey === proposal.canonicalClaimKey,
    );
    if (sharesClaimKey) {
      // Same canonical claim is known but no unique compatible target:
      // fail closed rather than risk a false shared closure.
      return { action: "skip", kind, reasonCode: "ambiguous_loop_identity" };
    }
    // A claim key unknown to every candidate is a fresh binding that proves
    // this proposal is none of the existing Loops: form a new one.
    return {
      action: "create_loop",
      kind,
      expectedStartAt,
      expectedEndAt,
      precision: validated.anchored ? validated.precision : "unknown",
      timezone: validated.anchored ? validated.timezone : null,
      followupEligibleFromAt: schedule.followupEligibleFromAt,
      expiresAt: schedule.expiresAt,
      expirySource: schedule.expirySource,
    };
  }
  // Without any identity proof (no explicit binding, no canonical claim),
  // same-kind candidates with a compatible window are similar candidates the
  // proposal cannot uniquely resolve: fail closed instead of risking a false
  // shared closure or a duplicate Loop. Distinct kinds or incompatible
  // windows still form a new Loop.
  const hasSimilarCandidate = input.identityCandidates.some(
    (candidate) =>
      candidate.kind === kind &&
      windowsCompatible(
        { startAt: expectedStartAt, endAt: expectedEndAt },
        {
          startAt: candidate.expectedStartAt,
          endAt: candidate.expectedEndAt,
        },
      ),
  );
  if (hasSimilarCandidate) {
    return { action: "skip", kind, reasonCode: "ambiguous_loop_identity" };
  }
  return {
    action: "create_loop",
    kind,
    expectedStartAt,
    expectedEndAt,
    precision: validated.anchored ? validated.precision : "unknown",
    timezone: validated.anchored ? validated.timezone : null,
    followupEligibleFromAt: schedule.followupEligibleFromAt,
    expiresAt: schedule.expiresAt,
    expirySource: schedule.expirySource,
  };
}

/**
 * Closure matching for one Event against its pre-transaction open snapshot.
 * Entailment is asserted by the caller from final/corrected User Evidence;
 * this function never infers closure from keywords, time arrival, silence or
 * Assistant/System content. Cancel additionally requires explicit
 * cancel/withdraw/abandon language. Ambiguous entailment across several
 * reasonable targets closes none and suppresses all of them atomically.
 */
export function planOpenLoopClosure(input: Readonly<{
  proposals: readonly OpenLoopClosureProposal[];
  openLoopSnapshot: readonly Readonly<{
    openLoopId: OpenLoopId;
    kind: OpenLoopKind;
    status: "open";
  }>[];
}>): OpenLoopClosurePlan {
  const entailed = input.proposals.filter(
    (proposal) => proposal.entailsTerminal,
  );
  if (entailed.length === 0) {
    return { action: "no_close", reasonCode: "no_entailment" };
  }
  for (const proposal of entailed) {
    if (!isKindStatusPairValid(proposal.targetKind, proposal.proposedStatus)) {
      return { action: "no_close", reasonCode: "kind_status_mismatch" };
    }
    // Cancel must be explicit; an entailed-but-implicit cancel never closes.
    if (proposal.proposedStatus === "canceled" && !proposal.explicitCancel) {
      return { action: "no_close", reasonCode: "cancel_not_explicit" };
    }
  }
  const byTarget = new Map<string, OpenLoopClosureProposal>();
  for (const proposal of entailed) {
    const existing = byTarget.get(proposal.targetOpenLoopId);
    if (existing && existing.proposedStatus !== proposal.proposedStatus) {
      return { action: "no_close", reasonCode: "kind_status_mismatch" };
    }
    byTarget.set(proposal.targetOpenLoopId, proposal);
  }
  const snapshotById = new Map(
    input.openLoopSnapshot.map((row) => [row.openLoopId, row] as const),
  );
  // A target is reasonable only when it is open in the snapshot AND its
  // snapshot kind matches the proposal's asserted kind: caller-supplied kinds
  // never authorize a cross-kind close on their own.
  const reasonableTargets = [...byTarget.entries()]
    .filter(([targetId, proposal]) => {
      const row = snapshotById.get(targetId as OpenLoopId);
      return row !== undefined && row.kind === proposal.targetKind;
    })
    .map(([targetId]) => targetId);
  if (reasonableTargets.length === 0) {
    return { action: "no_close", reasonCode: "no_reasonable_target" };
  }
  if (reasonableTargets.length > 1) {
    return {
      action: "ambiguous_suppress",
      targetOpenLoopIds: [...reasonableTargets].sort() as OpenLoopId[],
      disposition: "ambiguous_closure",
    };
  }
  const winner = byTarget.get(reasonableTargets[0]!)!;
  return {
    action: "close",
    targetOpenLoopId: winner.targetOpenLoopId,
    terminalStatus: winner.proposedStatus,
  };
}

/**
 * Closure/expiry arbitration uses only the authoritative User Event
 * `committed_at < expires_at`. A pre-expiry Event wins even when the expiry
 * scanner already materialized `expired`; boundary-equal or later Events
 * never rewrite `expired`. Worker completion order and user-narrated
 * real-world time never participate.
 */
export function arbitrateClosureVsExpiry(input: Readonly<{
  closureCommittedAt: string;
  expiresAt: string;
}>): "closure_wins" | "expiry_wins" {
  const committed = new Date(input.closureCommittedAt).getTime();
  const expiry = new Date(input.expiresAt).getTime();
  if (Number.isNaN(committed) || Number.isNaN(expiry)) {
    return "expiry_wins";
  }
  return committed < expiry ? "closure_wins" : "expiry_wins";
}

/**
 * Deterministic per-Event capacity: at most 4 new logical Loops, at most 128
 * current open per owner (suppressed included). Closure/retraction frees
 * capacity first; overflow selects by followup ASC, expiry ASC, locator ASC
 * without model importance and never evicts existing state.
 */
export function selectFormationCandidates(input: Readonly<{
  candidates: readonly OpenLoopCapacityCandidate[];
  currentOpenCount: number;
  freedByClosureCount?: number;
}>): Readonly<{
  selected: readonly OpenLoopCapacityCandidate[];
  skipped: readonly OpenLoopCapacityCandidate[];
}> {
  const freed = input.freedByClosureCount ?? 0;
  const availableOwnerSlots = Math.max(
    0,
    MAX_CURRENT_OPEN_LOOPS_PER_OWNER - (input.currentOpenCount - freed),
  );
  const allowed = Math.min(
    MAX_NEW_LOOPS_PER_EVENT,
    availableOwnerSlots,
    input.candidates.length,
  );
  const sorted = [...input.candidates].sort((left, right) => {
    if (left.followupEligibleFromAt !== right.followupEligibleFromAt) {
      return left.followupEligibleFromAt < right.followupEligibleFromAt
        ? -1
        : 1;
    }
    if (left.expiresAt !== right.expiresAt) {
      return left.expiresAt < right.expiresAt ? -1 : 1;
    }
    if (left.evidenceLocator !== right.evidenceLocator) {
      return left.evidenceLocator < right.evidenceLocator ? -1 : 1;
    }
    return left.proposalIndex - right.proposalIndex;
  });
  return {
    selected: sorted.slice(0, allowed),
    skipped: sorted.slice(allowed),
  };
}

/** Read-path eligibility: `followup_eligible_from_at <= now < expires_at`. */
export function isOpenLoopEligibleForFollowup(input: Readonly<{
  followupEligibleFromAt: string;
  expiresAt: string;
  now: Date;
}>): boolean {
  const eligibleFrom = new Date(input.followupEligibleFromAt).getTime();
  const expiry = new Date(input.expiresAt).getTime();
  const nowMs = input.now.getTime();
  if (Number.isNaN(eligibleFrom) || Number.isNaN(expiry)) {
    return false;
  }
  return eligibleFrom <= nowMs && nowMs < expiry;
}

/**
 * Complete watermark gates the whole lane: without a settled snapshot over
 * every final/corrected Event (no pending invalidation), the Open Loop
 * section reads empty instead of reusing a stale cache. Base lanes continue.
 */
export function isOpenLoopLaneReadable(input: Readonly<{
  snapshotSettledThroughCommittedAt: string | null;
  maxFinalEventCommittedAt: string | null;
  hasPendingInvalidation: boolean;
}>): boolean {
  if (input.hasPendingInvalidation) {
    return false;
  }
  if (!input.snapshotSettledThroughCommittedAt) {
    return false;
  }
  if (!input.maxFinalEventCommittedAt) {
    return true;
  }
  return (
    new Date(input.snapshotSettledThroughCommittedAt).getTime() >=
    new Date(input.maxFinalEventCommittedAt).getTime()
  );
}

/**
 * Terminal revival guard: occurred/resolved/canceled never reopen. Expired /
 * retracted may re-form on the same logical identity only from new, uniquely
 * matching direct Evidence under current gates. Old Evidence, time passage,
 * confidence, repair and reconciliation never revive.
 */
export function canReformTerminalLoop(input: Readonly<{
  terminalStatus: OpenLoopTerminalStatus;
  hasNewUniquelyMatchingDirectEvidence: boolean;
}>): boolean {
  if (
    input.terminalStatus === "occurred" ||
    input.terminalStatus === "resolved" ||
    input.terminalStatus === "canceled"
  ) {
    return false;
  }
  return input.hasNewUniquelyMatchingDirectEvidence;
}

/** 30-day content grace from leaving current open, read-path enforced. */
export function isOpenLoopSummaryReadable(input: Readonly<{
  status: "open" | OpenLoopTerminalStatus;
  leftOpenAt: string | null;
  now: Date;
}>): boolean {
  if (input.status === "open") {
    return true;
  }
  if (!input.leftOpenAt) {
    return false;
  }
  const left = new Date(input.leftOpenAt).getTime();
  if (Number.isNaN(left)) {
    return false;
  }
  const graceMs = 30 * 86_400_000;
  return input.now.getTime() - left < graceMs;
}

/**
 * Stable semantic target for the keyed dedupe fingerprint. Identity derives
 * from the deterministic formation result, never from model confidence.
 */
export function openLoopSemanticTarget(input: Readonly<{
  kind: OpenLoopKind;
  plan: OpenLoopFormationPlan;
  evidenceRevisionId: string;
}>): string {
  const identity =
    input.plan.action === "reuse_loop" ? input.plan.openLoopId : "new";
  const window =
    input.plan.action === "skip"
      ? "skip"
      : `${input.plan.expectedStartAt ?? "none"}|${input.plan.expectedEndAt ?? "none"}`;
  return `${input.kind}|${identity}|${window}|${input.evidenceRevisionId}`;
}

export function openLoopDedupeFingerprint(input: Readonly<{
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  policyVersion: string;
  secret: string;
}>): string {
  if (input.secret.trim() === "") {
    throw new Error("open loop dedupe fingerprint secret must not be empty.");
  }
  if (input.userId.trim() === "") {
    throw new Error("open loop dedupe fingerprint requires an owner binding.");
  }
  return createHmac("sha256", input.secret)
    .update(
      [
        OPEN_LOOP_DEDUPE_FINGERPRINT_KEY_VERSION,
        input.userId,
        input.semanticTarget,
        [...input.evidenceRevisionIds].sort().join(","),
        input.policyVersion,
      ].join("\n"),
    )
    .digest("hex");
}

export type { OpenLoopTerminalStatus };
