import {
  PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR,
  PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_MAX_CANDIDATES,
  PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
  type ProactiveFollowupCandidate,
  type ProactiveFollowupLaneSnapshot,
  type ProactiveFollowupManifestCandidate,
  type ProactiveFollowupRankTuple,
  type ProactiveFollowupSelectionInput,
  type ProactiveFollowupSelectionManifest,
  type ProactiveFollowupSelectionResult,
  type ProactiveFollowupStateSnapshot,
} from "./types";

const NEVER_USED = "1970-01-01T00:00:00.000Z";

type CandidateDecision = Readonly<{
  candidate: ProactiveFollowupCandidate;
  state: ProactiveFollowupStateSnapshot | null;
  rankTuple: ProactiveFollowupRankTuple | null;
  eligible: boolean;
  exclusionReason: string | null;
}>;

function targetKey(target: Readonly<{
  targetKind: string;
  targetId: string;
}>): string {
  return `${target.targetKind}:${target.targetId}`;
}

function isValidIso(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function compareDescending(left: string, right: string): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function compareRankTuple(
  left: ProactiveFollowupRankTuple,
  right: ProactiveFollowupRankTuple,
): number {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  const lastUsed = left[3] === right[3] ? 0 : left[3] < right[3] ? -1 : 1;
  if (lastUsed !== 0) return lastUsed;
  const evidence = compareDescending(left[4], right[4]);
  if (evidence !== 0) return evidence;
  return left[5].localeCompare(right[5]);
}

function laneRank(
  opportunity: ProactiveFollowupSelectionInput["opportunity"],
  candidate: ProactiveFollowupCandidate,
): 0 | 1 {
  if (opportunity === "greeting" || opportunity === "open_start") {
    return candidate.targetKind === "open_loop" ? 0 : 1;
  }
  return candidate.targetKind === "memory_claim" ? 0 : 1;
}

function makeRankTuple(
  input: ProactiveFollowupSelectionInput,
  candidate: ProactiveFollowupCandidate,
  state: ProactiveFollowupStateSnapshot | null,
): ProactiveFollowupRankTuple | null {
  if (!isValidIso(candidate.evidenceAt)) return null;
  const lastUsedAt = state?.lastUsedAt ?? candidate.lastUsedAt;
  if (lastUsedAt !== null && !isValidIso(lastUsedAt)) return null;
  return [
    candidate.sensitive ? 1 : 0,
    laneRank(input.opportunity, candidate),
    lastUsedAt === null ? 0 : 1,
    lastUsedAt ?? NEVER_USED,
    candidate.evidenceAt,
    `${candidate.targetKind}:${candidate.targetId}:${candidate.targetVersionId}`,
  ];
}

function laneIsReadable(
  input: ProactiveFollowupSelectionInput,
  lane: ProactiveFollowupLaneSnapshot,
): boolean {
  return (
    !lane.enabled ||
    (lane.status === "complete" &&
      lane.integrity === "valid" &&
      lane.manifestVersion !== "" &&
      lane.watermark !== null &&
      lane.watermark.sourceRevision === input.currentSourceRevision &&
      lane.watermark.coveredThroughSequence >= input.currentUserEventSequence)
  );
}

function selectionManifest(
  input: ProactiveFollowupSelectionInput,
  decision: "selected" | "none",
  reason: string,
  candidateDecisions: readonly CandidateDecision[],
  selectedTarget: ProactiveFollowupSelectionManifest["selectedTarget"],
): ProactiveFollowupSelectionManifest {
  return {
    manifestVersion: PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
    selectionPolicyVersion: PROACTIVE_FOLLOWUP_SELECTION_POLICY_VERSION,
    userId: input.userId,
    dailySessionId: input.dailySessionId,
    continuousExchangeNo: input.continuousExchangeNo,
    currentUserEventRevisionId: input.currentUserEventRevisionId,
    currentUserEventSequence: input.currentUserEventSequence,
    currentSourceRevision: input.currentSourceRevision,
    opportunity: input.opportunity,
    decision,
    reason,
    lanes: input.lanes.map((lane) => ({
      name: lane.name,
      enabled: lane.enabled,
      status: lane.status,
      watermark: lane.watermark,
      manifestVersion: lane.manifestVersion,
      integrity: lane.integrity,
      candidateCount: lane.candidates.length,
    })),
    candidates: candidateDecisions.map<ProactiveFollowupManifestCandidate>(
      ({ candidate, rankTuple, eligible, exclusionReason }) => ({
        targetKind: candidate.targetKind,
        targetId: candidate.targetId,
        targetVersionId: candidate.targetVersionId,
        rankTuple,
        eligible,
        exclusionReason,
      }),
    ),
    selectedTarget,
  };
}

function none(
  input: ProactiveFollowupSelectionInput,
  reason: string,
  candidateDecisions: readonly CandidateDecision[] = [],
): ProactiveFollowupSelectionResult {
  return {
    outcome: "none",
    reason,
    manifest: selectionManifest(input, "none", reason, candidateDecisions, null),
  };
}

function uniqueCandidates(
  lanes: readonly ProactiveFollowupLaneSnapshot[],
): readonly ProactiveFollowupCandidate[] | null {
  const seen = new Set<string>();
  const candidates: ProactiveFollowupCandidate[] = [];
  for (const lane of lanes) {
    for (const candidate of lane.candidates) {
      const key = targetKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates.length <= PROACTIVE_FOLLOWUP_MAX_CANDIDATES
    ? candidates
    : null;
}

function stateMap(
  states: readonly ProactiveFollowupStateSnapshot[],
): ReadonlyMap<string, ProactiveFollowupStateSnapshot> | null {
  const map = new Map<string, ProactiveFollowupStateSnapshot>();
  for (const state of states) {
    const key = targetKey(state);
    if (map.has(key)) return null;
    map.set(key, state);
  }
  return map;
}

function candidateDecision(
  input: ProactiveFollowupSelectionInput,
  candidate: ProactiveFollowupCandidate,
  states: ReadonlyMap<string, ProactiveFollowupStateSnapshot>,
): CandidateDecision {
  const state = states.get(targetKey(candidate)) ?? null;
  const fail = (exclusionReason: string): CandidateDecision => ({
    candidate,
    state,
    rankTuple: null,
    eligible: false,
    exclusionReason,
  });
  if (
    candidate.targetId === "" ||
    candidate.targetVersionId === "" ||
    candidate.targetKind === undefined
  ) {
    return fail("invalid_target_identity");
  }
  if (!candidate.current) return fail("target_not_current");
  if (!candidate.eligible) return fail("candidate_not_eligible");
  if (candidate.trustFence !== "valid") return fail("trust_fence");
  if (candidate.mentionedInExchange) return fail("mentioned_in_exchange");
  if (candidate.formedInCurrentTurn) return fail("formed_in_current_turn");
  if (state && state.targetVersionId !== candidate.targetVersionId) {
    return fail("state_version_mismatch");
  }
  if (
    state &&
    (state.eligibilityStatus === "suppressed" ||
      state.suppressedUntilAt !== null)
  ) {
    return fail("suppressed");
  }
  const rankTuple = makeRankTuple(input, candidate, state);
  return rankTuple
    ? {
        candidate,
        state,
        rankTuple,
        eligible: true,
        exclusionReason: null,
      }
    : fail("invalid_rank_input");
}

/**
 * Select zero or one target. Every failure before candidate ranking is a
 * whole-selection failure; an individual target failure only removes that
 * target. The returned manifest is safe to persist because it contains no
 * Evidence or rendered Memory text.
 */
export function selectProactiveFollowupTarget(
  input: ProactiveFollowupSelectionInput,
): ProactiveFollowupSelectionResult {
  if (!Number.isFinite(input.now.getTime())) {
    return none(input, "invalid_clock");
  }
  if (
    input.continuousExchangeNo < 1 ||
    input.currentUserEventSequence < 1 ||
    input.currentSourceRevision < 0
  ) {
    return none(input, "invalid_exchange_identity");
  }
  if (input.ordinaryQuestionAlreadyAsked) {
    return none(input, "ordinary_question_present");
  }
  if (
    input.opportunity === "current_topic" ||
    input.opportunity === "direct_task" ||
    input.opportunity === "urgent_or_high_risk"
  ) {
    return none(input, "focus_required_by_opportunity");
  }
  const dialogue = input.dialogue;
  if (
    dialogue.status !== "current" ||
    dialogue.coveredThroughSequence !== input.currentUserEventSequence ||
    dialogue.currentEventSequence !== input.currentUserEventSequence ||
    dialogue.currentEventRevisionId !== input.currentUserEventRevisionId ||
    dialogue.currentRequestRequiresFocus.value !== false ||
    dialogue.currentRequestRequiresFocus.confidence <
      PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR ||
    !Number.isFinite(dialogue.currentRequestRequiresFocus.confidence) ||
    !dialogue.currentRequestRequiresFocus.sourceRevisionIds.includes(
      input.currentUserEventRevisionId,
    )
  ) {
    return none(input, "dialogue_state_not_ready");
  }
  const enabledLanes = input.lanes.filter((lane) => lane.enabled);
  if (enabledLanes.length === 0) return none(input, "no_enabled_lane");
  if (input.lanes.some((lane) => !laneIsReadable(input, lane))) {
    return none(input, "lane_not_readable");
  }
  const candidates = uniqueCandidates(input.lanes);
  if (candidates === null) return none(input, "candidate_capacity_exceeded");
  const states = stateMap(input.states);
  if (states === null) return none(input, "state_integrity");

  const decisions = candidates.map((candidate) =>
    candidateDecision(input, candidate, states),
  );
  const eligible = decisions
    .filter(
      (decision): decision is CandidateDecision & {
        rankTuple: ProactiveFollowupRankTuple;
        eligible: true;
      } => decision.eligible && decision.rankTuple !== null,
    )
    .sort((left, right) => compareRankTuple(left.rankTuple, right.rankTuple));
  const selected = eligible[0];
  if (!selected) return none(input, "no_eligible_target", decisions);
  const target = {
    targetKind: selected.candidate.targetKind,
    targetId: selected.candidate.targetId,
    targetVersionId: selected.candidate.targetVersionId,
    source: selected.candidate.source,
    sensitive: selected.candidate.sensitive,
  } as const;
  const manifest = selectionManifest(
    input,
    "selected",
    "selected",
    decisions,
    {
      targetKind: target.targetKind,
      targetId: target.targetId,
      targetVersionId: target.targetVersionId,
    },
  );
  return { outcome: "selected", target, manifest };
}

