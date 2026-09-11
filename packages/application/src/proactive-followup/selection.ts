import {
  PROACTIVE_FOLLOWUP_DIALOGUE_CONFIDENCE_FLOOR,
  PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS,
  PROACTIVE_FOLLOWUP_MANIFEST_VERSION,
  PROACTIVE_FOLLOWUP_MAX_CANDIDATES,
  PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION,
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
const OPEN_LOOP_UNANCHORED_START = "9999-12-31T23:59:59.999Z";
const MAX_SOURCE_RANK = 999_999_999_999;

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

function normalizedIso(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function compareDescending(left: string, right: string): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function compareRankTuple(
  left: ProactiveFollowupRankTuple,
  right: ProactiveFollowupRankTuple,
): number {
  for (const index of [0, 1] as const) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  const withinLane = left[2] === right[2] ? 0 : left[2] < right[2] ? -1 : 1;
  if (withinLane !== 0) return withinLane;
  const lastUsed = left[4] === right[4] ? 0 : left[4] < right[4] ? -1 : 1;
  if (lastUsed !== 0) return lastUsed;
  const evidence = compareDescending(left[5], right[5]);
  if (evidence !== 0) return evidence;
  return left[6].localeCompare(right[6]);
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
  const evidenceAt = normalizedIso(candidate.evidenceAt);
  const lastUsedAt = state ? state.lastUsedAt : candidate.lastUsedAt;
  const normalizedLastUsedAt =
    lastUsedAt === null ? NEVER_USED : normalizedIso(lastUsedAt);
  if (evidenceAt === null || normalizedLastUsedAt === null) return null;

  let withinLane: string | null = null;
  if (candidate.targetKind === "open_loop") {
    if (
      candidate.source !== "open_loop" ||
      candidate.expiresAt === undefined ||
      candidate.expiresAt === null
    ) {
      return null;
    }
    const expiresAt = normalizedIso(candidate.expiresAt);
    const expectedStartAt =
      candidate.expectedStartAt === undefined || candidate.expectedStartAt === null
        ? OPEN_LOOP_UNANCHORED_START
        : normalizedIso(candidate.expectedStartAt);
    if (expiresAt === null || expectedStartAt === null) return null;
    if (
      expectedStartAt !== OPEN_LOOP_UNANCHORED_START &&
      Date.parse(expectedStartAt) >= Date.parse(expiresAt)
    ) {
      return null;
    }
    withinLane = `open-loop:${expectedStartAt}:${expiresAt}`;
  } else {
    if (
      candidate.source === "open_loop" ||
      candidate.sourceRank === null ||
      !Number.isSafeInteger(candidate.sourceRank) ||
      candidate.sourceRank < 0 ||
      candidate.sourceRank > MAX_SOURCE_RANK
    ) {
      return null;
    }
    withinLane = `memory:${candidate.sourceRank.toString().padStart(12, "0")}`;
  }

  return [
    candidate.sensitive ? 1 : 0,
    laneRank(input.opportunity, candidate),
    withinLane,
    lastUsedAt === null ? 0 : 1,
    normalizedLastUsedAt,
    evidenceAt,
    `${candidate.targetKind}:${candidate.targetId}:${candidate.targetVersionId}`,
  ];
}

function laneManifestIsKnown(lane: ProactiveFollowupLaneSnapshot): boolean {
  if (lane.name === "open_loop") {
    return lane.manifestVersion === PROACTIVE_FOLLOWUP_OPEN_LOOP_LANE_MANIFEST_VERSION;
  }
  return (PROACTIVE_FOLLOWUP_MEMORY_LANE_MANIFEST_VERSIONS as readonly string[]).includes(
    lane.manifestVersion,
  );
}

function laneIsReadable(
  input: ProactiveFollowupSelectionInput,
  lane: ProactiveFollowupLaneSnapshot,
): boolean {
  const candidateShapesMatchLane = lane.candidates.every((candidate) =>
    lane.name === "open_loop"
      ? candidate.targetKind === "open_loop" && candidate.source === "open_loop"
      : candidate.targetKind === "memory_claim" &&
        (candidate.source === "person_portrait" ||
          candidate.source === "query_retrieval"),
  );
  return (
    !lane.enabled ||
    (lane.status === "complete" &&
      lane.integrity === "valid" &&
      laneManifestIsKnown(lane) &&
      candidateShapesMatchLane &&
      lane.watermark !== null &&
      Number.isInteger(lane.watermark.sourceRevision) &&
      lane.watermark.sourceRevision >= 0 &&
      Number.isInteger(lane.watermark.coveredThroughSequence) &&
      lane.watermark.coveredThroughSequence >= 0 &&
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
      ({ candidate, state, rankTuple, eligible, exclusionReason }) => ({
        targetKind: candidate.targetKind,
        targetId: candidate.targetId,
        targetVersionId: candidate.targetVersionId,
        rankTuple,
        stateVersionId: state?.stateVersionId ?? null,
        suppressionReason: state?.suppressionReason ?? null,
        consecutiveSoftStopCount: state?.consecutiveSoftStopCount ?? 0,
        suppressedUntilAt: state?.suppressedUntilAt ?? null,
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
  const seen = new Map<string, string>();
  const candidates: ProactiveFollowupCandidate[] = [];
  for (const lane of lanes) {
    for (const candidate of lane.candidates) {
      const key = targetKey(candidate);
      const existingVersion = seen.get(key);
      if (existingVersion !== undefined) {
        if (existingVersion !== candidate.targetVersionId) return null;
        continue;
      }
      seen.set(key, candidate.targetVersionId);
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
    !["open_loop", "memory_claim"].includes(candidate.targetKind) ||
    !["open_loop", "person_portrait", "query_retrieval"].includes(
      candidate.source,
    )
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
    input.currentSourceRevision < 0 ||
    !Number.isInteger(input.continuousExchangeNo) ||
    !Number.isInteger(input.currentUserEventSequence) ||
    !Number.isInteger(input.currentSourceRevision) ||
    input.userId === "" ||
    input.dailySessionId === "" ||
    input.currentUserEventRevisionId === ""
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
  if (
    new Set(input.lanes.map((lane) => lane.name)).size !== input.lanes.length
  ) {
    return none(input, "lane_integrity");
  }
  if (input.lanes.some((lane) => !laneIsReadable(input, lane))) {
    return none(input, "lane_not_readable");
  }
  const candidates = uniqueCandidates(enabledLanes);
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
