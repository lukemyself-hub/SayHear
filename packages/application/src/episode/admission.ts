import { createHmac } from "node:crypto";

import type { EpisodeId } from "@sayhear/domain";

import type {
  EpisodeAdmissionPlan,
  EpisodeAdmissionRejectionCode,
  EpisodeBoundary,
  EpisodeBuildModelRequest,
  EpisodeCandidateDispositionPlan,
  EpisodeContent,
  EpisodeKind,
  EpisodeProposal,
  EpisodeTemporalAnchor,
} from "./types";
import {
  EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION,
  EPISODE_TERMINAL_CONTENT_EXPIRY_DAYS,
  episodeKindTypedFields,
  isEpisodeKind,
} from "./types";

/**
 * Deterministic `episode-admission:v1` core (issue #197, ADR-0037/0120).
 * Pure functions only: `now` and all live state are injected by the caller so
 * every rule is replayable in unit tests and stable under concurrent builds.
 */

const ONGOING_HIGH_DATE = "9999-12-31";

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === value;
}

function isValidBoundary(boundary: EpisodeBoundary): boolean {
  switch (boundary.precision) {
    case "exact":
      return typeof boundary.date === "string" && isIsoDate(boundary.date);
    case "month":
      return typeof boundary.date === "string"
        && /^\d{4}-\d{2}$/.test(boundary.date)
        && Number(boundary.date.slice(5, 7)) >= 1
        && Number(boundary.date.slice(5, 7)) <= 12;
    case "year":
      return typeof boundary.date === "string" && /^\d{4}$/.test(boundary.date);
    case "approximate":
      return boundary.date === undefined
        || (typeof boundary.date === "string"
          && ((/^\d{4}$/.test(boundary.date)
            || (/^\d{4}-\d{2}$/.test(boundary.date)
              && Number(boundary.date.slice(5, 7)) >= 1
              && Number(boundary.date.slice(5, 7)) <= 12))
            || (/^\d{4}-\d{2}-\d{2}$/.test(boundary.date)
              && isIsoDate(boundary.date))));
    case "unknown":
      return boundary.date === undefined;
    default:
      return false;
  }
}

export type BoundaryWindow = Readonly<{
  lo: string;
  hi: string;
}>;

/**
 * Conservative comparable window for one boundary. `unknown` and dateless
 * `approximate` boundaries yield null: the system refuses to invent a
 * comparable range it cannot prove, so such anchors can never participate in
 * uniqueness matching without an explicit continuity span.
 */
export function boundaryWindow(
  boundary: EpisodeBoundary,
): BoundaryWindow | null {
  if (!isValidBoundary(boundary)) {
    return null;
  }
  switch (boundary.precision) {
    case "exact":
      return { lo: boundary.date!, hi: boundary.date! };
    case "month": {
      const [year, month] = boundary.date!.split("-");
      const lastDay = new Date(
        Date.UTC(Number(year), Number(month), 0),
      ).getUTCDate();
      return {
        lo: `${year}-${month}-01`,
        hi: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
      };
    }
    case "year":
      return { lo: `${boundary.date}-01-01`, hi: `${boundary.date}-12-31` };
    case "approximate": {
      const date = boundary.date;
      if (!date) {
        return null;
      }
      if (/^\d{4}$/.test(date)) {
        return { lo: `${date}-01-01`, hi: `${date}-12-31` };
      }
      if (/^\d{4}-\d{2}$/.test(date)) {
        return boundaryWindow({ date, precision: "month" });
      }
      return { lo: date, hi: date };
    }
    case "unknown":
      return null;
    default:
      return null;
  }
}

export function boundaryWindowsOverlap(
  left: EpisodeBoundary,
  right: EpisodeBoundary,
): boolean {
  const leftWindow = boundaryWindow(left);
  const rightWindow = boundaryWindow(right);
  if (leftWindow === null || rightWindow === null) {
    return false;
  }
  return leftWindow.lo <= rightWindow.hi && rightWindow.lo <= leftWindow.hi;
}

/**
 * The kind catalog is a code-versioned closed set. An unmapped proposal is
 * deterministically downgraded to `other` rather than rejected, so a
 * qualified real-world event is never discarded over vocabulary and no
 * runtime governance queue is needed (ADR-0120).
 */
export function normalizeEpisodeKind(proposedKind: string): EpisodeKind {
  return isEpisodeKind(proposedKind) ? proposedKind : "sh.episode.other";
}

/**
 * Whether an Episode horizon covers a candidate occurrence start: the
 * episode's start boundary must begin at or before the candidate and, when an
 * end boundary is recorded, extend at or beyond it. Unknown episode anchors
 * can never cover (conservative).
 */
function episodeCovers(
  episodeAnchor: EpisodeTemporalAnchor,
  candidateStart: EpisodeBoundary,
): boolean {
  const episodeLo = boundaryWindow(episodeAnchor.start)?.lo;
  const candidate = boundaryWindow(candidateStart);
  if (!episodeLo || !candidate) {
    return false;
  }
  const episodeHi = episodeAnchor.end
    ? boundaryWindow(episodeAnchor.end)?.hi
    : ONGOING_HIGH_DATE;
  if (!episodeHi) {
    return false;
  }
  return candidate.lo >= episodeLo && candidate.lo <= episodeHi;
}

/**
 * Deterministic admission for one proposal against the frozen build input.
 * The gate order is fixed so identical inputs always produce identical plans.
 */
export function planEpisodeAdmission(input: Readonly<{
  proposal: EpisodeProposal;
  request: EpisodeBuildModelRequest;
  resolvableEntityIds?: readonly string[];
}>): EpisodeAdmissionPlan {
  const { proposal, request } = input;
  const kind = normalizeEpisodeKind(proposal.proposedKind);

  const evidenceById = new Map(
    request.evidence.map((item) => [item.evidenceItemId, item]),
  );
  const cited = proposal.citedEvidenceItemIds;
  if (cited.length === 0) {
    return { action: "reject", kind, rejectionCode: "cited_evidence_missing" };
  }
  if (!cited.every((id) => evidenceById.has(id))) {
    return { action: "reject", kind, rejectionCode: "evidence_ineligible" };
  }

  // Real-world anchor gate applies uniformly to every kind including
  // `other` (ADR-0037, ADR-0120).
  if (!proposal.realWorldOccurrence) {
    return { action: "reject", kind, rejectionCode: "no_real_world_anchor" };
  }

  if (typeof proposal.label !== "string" || proposal.label.trim() === "") {
    return { action: "reject", kind, rejectionCode: "label_invalid" };
  }
  if (
    !isValidBoundary(proposal.temporalAnchor.start)
    || (proposal.temporalAnchor.end !== undefined
      && !isValidBoundary(proposal.temporalAnchor.end))
  ) {
    return {
      action: "reject",
      kind,
      rejectionCode: "temporal_anchor_invalid",
    };
  }

  const allowedTypedFields = episodeKindTypedFields(kind);
  const rawTypedEntries = Object.entries(proposal.kindFields ?? {});
  const typedFieldsValid = rawTypedEntries.every(
    ([key, value]) =>
      allowedTypedFields.includes(key) && typeof value === "string",
  );
  if (!typedFieldsValid && isEpisodeKind(proposal.proposedKind)) {
    return { action: "reject", kind, rejectionCode: "typed_field_invalid" };
  }
  // Deterministic kind downgrade also downgrades the typed fields.
  const kindFieldEntries = typedFieldsValid
    ? rawTypedEntries
    : rawTypedEntries.filter(
        ([key, value]) =>
          allowedTypedFields.includes(key) && typeof value === "string",
      );

  const entityAnchors = [...(proposal.entityAnchorIds ?? [])];
  if (entityAnchors.some((id) => id.trim() === "")) {
    return { action: "reject", kind, rejectionCode: "entity_anchor_invalid" };
  }
  if (entityAnchors.length > 0) {
    // Entity anchors must be concrete Entity IDs of the current owner; an
    // ambiguous multi-candidate mention is never upgraded into one.
    const resolvable = new Set(input.resolvableEntityIds ?? []);
    if (!entityAnchors.every((id) => resolvable.has(id))) {
      return {
        action: "reject",
        kind,
        rejectionCode: "entity_anchor_ambiguous",
      };
    }
  }

  const content: EpisodeContent = {
    kind,
    label: proposal.label.trim(),
    temporalAnchor: proposal.temporalAnchor,
    phase: proposal.phase,
    kindFields: Object.fromEntries(kindFieldEntries),
  };

  // Uniqueness scope: same kind, episode horizon covering the candidate
  // occurrence start, and at least one shared entity anchor when the
  // proposal carries entity anchors.
  const candidateStart = proposal.temporalAnchor.start;
  const hits = request.activeEpisodes.filter(
    (episode) =>
      episode.kind === kind
      && episode.temporalAnchor !== null
      && episodeCovers(episode.temporalAnchor, candidateStart)
      && (entityAnchors.length === 0
        || entityAnchors.some((id) => episode.entityAnchorIds.includes(id))),
  );

  const continuity = proposal.explicitContinuity;
  const continuityEvidence = continuity
    ? request.evidence.find((item) => item.evidenceItemId === continuity.evidenceItemId)
    : undefined;
  const continuityValid =
    continuity !== undefined
    && continuityEvidence !== undefined
    && continuity.span.trim().length > 0
    && continuityEvidence.sourceText.includes(continuity.span);

  const sameKindActiveEpisodes = request.activeEpisodes.filter(
    (episode) => episode.kind === kind,
  );

  if (continuityValid) {
    if (hits.length === 1) {
      return {
        action: "continue_episode",
        kind,
        content,
        episodeId: hits[0]!.episodeId,
        resolutionStatus: "matched",
        explicitContinuitySpan: continuity.span,
      };
    }
    if (hits.length === 0 && sameKindActiveEpisodes.length === 1) {
      // The user's explicit continuity expression is direct Evidence; with
      // exactly one active same-kind Episode it identifies the occurrence.
      return {
        action: "continue_episode",
        kind,
        content,
        episodeId: sameKindActiveEpisodes[0]!.episodeId,
        resolutionStatus: "matched",
        explicitContinuitySpan: continuity.span,
      };
    }
    return { action: "stay_unresolved", kind, resolutionStatus: "unresolved" };
  }

  // An explicitly new occurrence never continues an older Episode
  // (ADR-0037: a repeated place defaults to a separate event when the
  // Evidence shows a new occurrence).
  if (proposal.explicitNewOccurrence === true) {
    return {
      action: "create_episode",
      kind,
      content,
      resolutionStatus: "new",
    };
  }

  if (hits.length === 1) {
    return {
      action: "continue_episode",
      kind,
      content,
      episodeId: hits[0]!.episodeId,
      resolutionStatus: "matched",
      explicitContinuitySpan: null,
    };
  }
  if (hits.length === 0) {
    return {
      action: "create_episode",
      kind,
      content,
      resolutionStatus: "new",
    };
  }
  return { action: "stay_unresolved", kind, resolutionStatus: "unresolved" };
}

/**
 * Stable semantic target for the keyed dedupe fingerprint. Identity derives
 * from the deterministic admission result, never from model confidence or
 * free text (ADR-0051 keyed fence).
 */
export function episodeSemanticTarget(input: Readonly<{
  kind: EpisodeKind;
  proposal: EpisodeProposal;
  entityAnchorIds: readonly string[];
  plan: EpisodeAdmissionPlan;
}>): string {
  const identity =
    input.plan.action === "continue_episode"
      ? input.plan.episodeId
      : "new";
  const anchor = input.proposal.temporalAnchor.start;
  const anchorSignature = `|${anchor.date ?? "none"}|${anchor.precision}|${[...input.entityAnchorIds].sort().join(",")}`;
  return `${input.kind}|${identity}${anchorSignature}`;
}

export function episodeDedupeFingerprint(input: Readonly<{
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  policyVersion: string;
  secret: string;
}>): string {
  if (input.secret.trim() === "") {
    throw new Error("episode dedupe fingerprint secret must not be empty.");
  }
  if (input.userId.trim() === "") {
    throw new Error("episode dedupe fingerprint requires an owner binding.");
  }
  return createHmac("sha256", input.secret)
    .update(
      [
        EPISODE_DEDUPE_FINGERPRINT_KEY_VERSION,
        input.userId,
        input.semanticTarget,
        [...input.evidenceRevisionIds].sort().join(","),
        input.policyVersion,
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * Stale disposition uses the ORIGINAL policy deadline (ADR-0051 rule): the
 * sweeper only detects expiry; it never moves the terminal effective date.
 */
export function planEpisodeStaleDisposition(input: Readonly<{
  now: Date;
  originalDeadline: Date;
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  policyVersion: string;
  secret: string;
}>): EpisodeCandidateDispositionPlan {
  return {
    status: "stale",
    dispositionReasonCode: "unresolved_stale_expired",
    dispositionPolicyVersion: input.policyVersion,
    reproposalPolicy: "material_change_allowed",
    terminalEffectiveAt: input.originalDeadline,
    terminalContentExpiresAt: addDays(
      input.originalDeadline,
      EPISODE_TERMINAL_CONTENT_EXPIRY_DAYS,
    ),
    dedupeFingerprint: episodeDedupeFingerprint({
      userId: input.userId,
      semanticTarget: input.semanticTarget,
      evidenceRevisionIds: input.evidenceRevisionIds,
      policyVersion: input.policyVersion,
      secret: input.secret,
    }),
  };
}

export function planEpisodeRejectionDisposition(input: Readonly<{
  now: Date;
  rejectionCode: EpisodeAdmissionRejectionCode;
  userId: string;
  semanticTarget: string;
  evidenceRevisionIds: readonly string[];
  policyVersion: string;
  secret: string;
}>): EpisodeCandidateDispositionPlan {
  return {
    status: "rejected",
    dispositionReasonCode: input.rejectionCode,
    dispositionPolicyVersion: input.policyVersion,
    reproposalPolicy: "material_change_allowed",
    terminalEffectiveAt: input.now,
    terminalContentExpiresAt: addDays(input.now, EPISODE_TERMINAL_CONTENT_EXPIRY_DAYS),
    dedupeFingerprint: episodeDedupeFingerprint({
      userId: input.userId,
      semanticTarget: input.semanticTarget,
      evidenceRevisionIds: input.evidenceRevisionIds,
      policyVersion: input.policyVersion,
      secret: input.secret,
    }),
  };
}

/**
 * Materially-new-evidence successor rule (ADR-0052): a terminal candidate can
 * only gain a successor when the new proposal cites an evidence revision the
 * predecessor never saw. Structured comparison only — no similarity score.
 */
export function evaluateEpisodeMaterialChange(input: Readonly<{
  predecessorEvidenceRevisionIds: readonly string[];
  proposalEvidenceRevisionIds: readonly string[];
}>): Readonly<{
  materiallyNew: boolean;
  reasonCode: "no_new_evidence_revisions" | "new_evidence_revisions";
}> {
  const predecessor = new Set(input.predecessorEvidenceRevisionIds);
  const hasNew = input.proposalEvidenceRevisionIds.some(
    (revisionId) => !predecessor.has(revisionId),
  );
  return {
    materiallyNew: hasNew,
    reasonCode: hasNew
      ? "new_evidence_revisions"
      : "no_new_evidence_revisions",
  };
}

export function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

export type { EpisodeId };
