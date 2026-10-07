/**
 * The Daily-Session-scoped Safety Posture lifecycle (issue #76, ADR-0112,
 * architecture 08-10 §9.6, GLOSSARY.md "Safety Posture").
 *
 * Safety Posture is deterministic domain state on the Daily Session — not a
 * DialogueState field, not model state, and not cross-day crisis tracking. A
 * versioned deterministic detection of an explicit self-harm,
 * harm-to-others, or imminent-danger signal activates it; it survives
 * Continuous Exchange boundaries within the day and does not survive the day,
 * because its records are keyed by the Daily Session that the existing
 * session-resolution transaction already scopes.
 *
 * Release is automatic and deterministic: after K consecutive user turns with
 * no renewed signal the posture clears. K is a versioned parameter of this
 * policy, initially 2 — one clean turn would reproduce the recorded #61
 * baseline failure of losing the real-world-support anchor at turn two. An
 * explicit user statement of safety carries no signal, so it counts as
 * exactly one clean turn and never short-circuits; a renewed signal resets
 * the count. Neither timers nor model preference participate.
 *
 * Enforcement is compilation, not discretion: while active, the Context
 * Compiler renders the reduced persona variant (ADR-0112) and the compiled
 * `safety_posture` section keeps a real-world support anchor sourced from the
 * versioned whitelist in ./safety-resources — the single source shared with
 * the Minimum High-Risk Response and the eval hard gate (#72).
 *
 * Records keep a minimal envelope (ADR-0101 discipline): signal enums, the
 * clean-turn counter, and Event revision references only — never user or
 * assistant content.
 */

import type { ConversationEventRevisionId } from "@sayhear/domain";

import {
  detectMinimumHighRiskSignal,
  HIGH_RISK_KINDS,
  resolveConversationLocale,
  type HighRiskKind,
} from "./conversation-behavior";
import { listSafetyResourceNumbers, renderCrisisSupportSentence } from "./safety-resources";

export const SAFETY_POSTURE_POLICY_VERSION = "safety-posture:v2";

/**
 * K: the number of consecutive clean user turns that releases an active
 * posture (ADR-0112). This constant is the single runtime source; the
 * immutable `safety_posture_policies` row records the same value at the
 * storage boundary, and the system tests pin the two equal. Changing K is a
 * policy-version change: a new `safety-posture:vN` constant and policy row
 * together, never an inline literal tweak.
 */
export const SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE = 2;

/** Structural sanity bound for persisted counters, not a domain limit. */
const SAFETY_POSTURE_MAX_CLEAN_TURN_COUNT = 1_000;

/**
 * The machine-readable marker the compiled `safety_posture` section carries
 * while the posture is active. The deterministic Champion reflects the
 * compiled posture state from this marker (the way it reads the frozen
 * Action Reference Handles), so posture-active responses keep the anchor.
 */
export const SAFETY_POSTURE_ACTIVE_MARKER = "safety-posture:active";

export type SafetyPostureDetector = (
  input: { locale: string; text: string },
) => HighRiskKind | null;

/**
 * The default detector generalizes the turn-local Minimum High-Risk detection
 * (ADR-0010) into the posture's activation rule: the same versioned phrase
 * policy, now also writing domain state at the response-commit boundary. The
 * turn-local prompt-layer Minimum High-Risk Response remains the fallback
 * when this detector fails (ADR-0112).
 */
export const minimumHighRiskSafetyPostureDetector: SafetyPostureDetector = (
  input,
) => detectMinimumHighRiskSignal(input).kind;

/**
 * The bare lifecycle status. The eval-side trajectory tier replays the same
 * deterministic rules over scenario transcripts, so the transition rules have
 * exactly one implementation.
 */
export type SafetyPostureStatus = Readonly<{
  cleanTurnCount: number;
  state: "default" | "active" | "released";
}>;

/**
 * The deterministic turn transition over the bare status. Every rule is code,
 * not model judgment: a detected signal activates (or re-activates, resetting
 * the count); a clean turn while active increments the count and releases at
 * K; a clean turn with no active posture changes nothing.
 */
export function nextSafetyPostureStatus(input: {
  cleanTurnsToRelease?: number;
  detected: HighRiskKind | null;
  status: SafetyPostureStatus;
}): SafetyPostureStatus {
  const cleanTurnsToRelease =
    input.cleanTurnsToRelease ?? SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE;
  if (input.detected !== null) {
    return { cleanTurnCount: 0, state: "active" };
  }
  if (input.status.state !== "active") {
    return input.status;
  }
  const cleanTurnCount = input.status.cleanTurnCount + 1;
  return {
    cleanTurnCount,
    state: cleanTurnCount >= cleanTurnsToRelease ? "released" : "active",
  };
}

/**
 * The persisted projection content. `state` is "active" while the posture
 * governs compilation and "released" once K clean turns cleared it; a session
 * that never activated today simply has no row. Evidence carries only Event
 * revision references.
 */
export type SafetyPostureContent = Readonly<{
  cleanTurnCount: number;
  evidence: Readonly<{
    /** The user Event revision whose signal activated the current posture. */
    activatedUserEventRevisionId: ConversationEventRevisionId;
    /** The user Event revision of the turn that produced this version. */
    lastTurnUserEventRevisionId: ConversationEventRevisionId;
  }>;
  kind: HighRiskKind;
  releasedBy: Readonly<{ userEventRevisionId: ConversationEventRevisionId }>
    | null;
  state: "active" | "released";
}>;

export type CurrentSafetyPosture = Readonly<{
  content: SafetyPostureContent;
  policyVersion: string;
  sourceRevision: number;
  id: string;
  versionNo: number;
}>;

/** The projection content that governs a compile, or null when default. */
export function activeSafetyPosture(
  content: SafetyPostureContent | null,
): SafetyPostureContent | null {
  return content !== null && content.state === "active" ? content : null;
}

/**
 * Apply one committed user turn to the projection. Returns the new content
 * when the turn changed it (activation, clean-turn count, release, renewal),
 * or null when there is nothing worth persisting. The caller attaches the
 * committing turn's evidence deterministically — the model never participates.
 */
export function applySafetyPostureTurn(input: {
  cleanTurnsToRelease?: number;
  content: SafetyPostureContent | null;
  currentUserEventRevisionId: ConversationEventRevisionId;
  detected: HighRiskKind | null;
}): SafetyPostureContent | null {
  if (input.content !== null) {
    validateSafetyPostureContent(input.content);
  }
  const status: SafetyPostureStatus =
    input.content === null
      ? { cleanTurnCount: 0, state: "default" }
      : {
          cleanTurnCount: input.content.cleanTurnCount,
          state: input.content.state,
        };
  const next = nextSafetyPostureStatus({
    ...(input.cleanTurnsToRelease === undefined
      ? {}
      : { cleanTurnsToRelease: input.cleanTurnsToRelease }),
    detected: input.detected,
    status,
  });
  if (
    next.state === status.state &&
    next.cleanTurnCount === status.cleanTurnCount
  ) {
    return null;
  }
  if (input.detected !== null) {
    const content: SafetyPostureContent = {
      cleanTurnCount: next.cleanTurnCount,
      evidence: {
        activatedUserEventRevisionId: input.currentUserEventRevisionId,
        lastTurnUserEventRevisionId: input.currentUserEventRevisionId,
      },
      kind: input.detected,
      releasedBy: null,
      state: "active",
    };
    validateSafetyPostureContent(content);
    return content;
  }
  // A clean turn only changes an existing active posture; the unreachable
  // guard keeps the narrowing explicit for the evidence carried forward.
  if (input.content === null) return null;
  const content: SafetyPostureContent = {
    cleanTurnCount: next.cleanTurnCount,
    evidence: {
      activatedUserEventRevisionId:
        input.content.evidence.activatedUserEventRevisionId,
      lastTurnUserEventRevisionId: input.currentUserEventRevisionId,
    },
    kind: input.content.kind,
    releasedBy:
      next.state === "released"
        ? { userEventRevisionId: input.currentUserEventRevisionId }
        : null,
    state: next.state === "released" ? "released" : "active",
  };
  validateSafetyPostureContent(content);
  return content;
}

/**
 * Structural validation of persisted content. The projection records are a
 * minimal envelope: signal enums, the clean-turn counter, and revision
 * references, and nothing else.
 */
export function validateSafetyPostureContent(
  content: SafetyPostureContent,
): void {
  if (content.state !== "active" && content.state !== "released") {
    throw new Error("SafetyPosture state is outside the bounded policy.");
  }
  if (!HIGH_RISK_KINDS.includes(content.kind)) {
    throw new Error("SafetyPosture activation kind is outside the bounded policy.");
  }
  if (
    !Number.isInteger(content.cleanTurnCount) ||
    content.cleanTurnCount < 0 ||
    content.cleanTurnCount > SAFETY_POSTURE_MAX_CLEAN_TURN_COUNT
  ) {
    throw new Error("SafetyPosture clean-turn count is outside the bound.");
  }
  if (
    !content.evidence?.activatedUserEventRevisionId ||
    !content.evidence?.lastTurnUserEventRevisionId
  ) {
    throw new Error("SafetyPosture requires revision-reference evidence.");
  }
  if (content.state === "active" && content.releasedBy !== null) {
    throw new Error("An active SafetyPosture cannot carry release evidence.");
  }
  if (content.state === "released" && content.releasedBy === null) {
    throw new Error("A released SafetyPosture requires release evidence.");
  }
  if (content.releasedBy !== null && !content.releasedBy.userEventRevisionId) {
    throw new Error("SafetyPosture releases require trigger evidence.");
  }
}

function renderSafetyAnchorNumbers(locale: string): string {
  return renderCrisisSupportSentence({ locale });
}

/**
 * Render the compiled `safety_posture` section for an active posture: the
 * deterministic status with its policy version, the exact reduced-persona
 * paused/retained sets (ADR-0112), and the real-world support anchor sourced
 * from the versioned whitelist. The rendered string is also the section
 * reference, so the Provider Egress re-derivation replays exactly the state
 * frozen at compile time.
 */
export function renderSafetyPosture(input: {
  content: SafetyPostureContent;
  locale: string;
  policyVersion: string;
}): string {
  const localeTag = resolveConversationLocale(input.locale);
  const releasePhrase =
    localeTag === "zh"
      ? `连续 ${SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE} 个干净 turn 自动解除`
      : `${SAFETY_POSTURE_CLEAN_TURNS_TO_RELEASE} consecutive clean user turns release it`;
  return [
    `Safety Posture (deterministic Daily-Session domain state; policy ${input.policyVersion}): ACTIVE (${SAFETY_POSTURE_ACTIVE_MARKER}) — an explicit ${input.content.kind.replace(/_/g, " ")} signal is held with care until ${releasePhrase}`,
    "Reduced persona variant while active:",
    "- Paused: Playful Warmth, ordinary Selective Curiosity, outward emotional self-reference, and non-essential opinions.",
    "- Retained: genuine warmth, care, and directness; a narrow question that serves immediate understanding of safety remains allowed.",
    localeTag === "zh"
      ? `本回应必须带上现实支持锚点（下方号码原样给出）：${renderSafetyAnchorNumbers(input.locale)}只要本段仍在上下文中，每一轮回应都要重复这个锚点——哪怕用户换了话题或看起来好转了；解除由确定性规则完成，不由你判断。`
      : `Every response while this section is present must repeat the real-world support anchor with these numbers: ${renderSafetyAnchorNumbers(input.locale)} Repeat it on every turn, in your own natural words — for example "and if it gets heavy again, ${renderCrisisSupportSentence({ locale: input.locale })}" — even if the user changed the topic or seems better. Release is deterministic, never your judgment.`,
  ].join("\n");
}

/**
 * The deterministic anchor the behavior-aware Champion appends to an ordinary
 * response on a posture-active turn. The activation turn already carries the
 * full Minimum High-Risk Response; this keeps the anchor alive on every later
 * posture-active turn, with numbers from the same versioned whitelist.
 */
export function renderSafetyPostureResponseAnchor(input: {
  locale: string;
}): string {
  if (resolveConversationLocale(input.locale) === "zh") {
    return `如果任何时候感到不安全，请立即联系现实支持：${renderSafetyAnchorNumbers(input.locale)}`;
  }
  return `If anything feels unsafe, please reach out to real-world support right away — ${renderSafetyAnchorNumbers(input.locale)}`;
}
