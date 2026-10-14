/**
 * Natural continuation of the current talk (issue #317, ADR-0152, ADR-0115
 * amendment).
 *
 * A continuation is an experience search (#316) whose clues come from the
 * current talk instead of from a question about the past. Nothing here widens
 * what may be read: the same bounded, owner/epoch/revision/Correction/Forget
 * qualified read serves it. This module only decides, deterministically:
 *
 * - which of the signals the model named are really valid for this turn
 *   (the current input is always valid; recent user messages only if the
 *   Decision was shown some; the DialogueState only while it is source-valid),
 * - which clues are too low-information to search for (greetings, thanks),
 * - which clues share the current talk's own words ("anchored"), and
 * - whether the earlier matters found are one, a leading one, tied, or too
 *   broad to tell apart (the evidence the answer stage may ask one question on).
 *
 * The signal texts live in memory for the duration of one admission. They are
 * never persisted, logged or copied into diagnostics; only counts and verdicts
 * are.
 */

import { normalizeRetrievalTerm } from "./memory-retrieval/types";
import {
  searchPatternsOf,
  type HistoryExperienceSearchPlan,
} from "./history-experience-search";
import type {
  HistoryContinuationBasis,
  HistoryContinuationClaim,
  HistoryExperienceSearchProposal,
} from "./history-recall";

export const HISTORY_CONTINUATION_POLICY_VERSION = "history-continuation:v1";

/** What this turn's Decision could see, resolved from its frozen context. */
export type HistoryContinuationSignals = Readonly<{
  /** The user's other recent messages in the Decision's context, nearest first. */
  adjacentUserTexts: readonly string[];
  currentInputText: string;
  /** Only a source-valid projection; null when failed, revoked or absent. */
  dialogueState: Readonly<{
    status: "current" | "lagging";
    topic: string | null;
  }> | null;
}>;

export const NO_CONTINUATION_SIGNALS: HistoryContinuationSignals = Object.freeze({
  adjacentUserTexts: Object.freeze([]),
  currentInputText: "",
  dialogueState: null,
});

export type HistoryContinuationVerdict =
  | "single"
  | "leading"
  | "tied"
  | "too_broad"
  | "none";

/** Content-free accounting of one continuation. */
export type HistoryContinuationCoverage = Readonly<{
  adjacentUserRows: number;
  /** Clue groups that share the current talk's own words. */
  anchoredClues: number;
  basis: readonly HistoryContinuationBasis[];
  basisRejected: readonly HistoryContinuationBasis[];
  dialogueState: "current" | "lagging" | "unavailable";
  leadingGroup: number | null;
  lowInformationClues: number;
  occasions: readonly Readonly<{
    anchoredSupport: number;
    group: number;
    support: number;
  }>[];
  policyVersion: string;
  verdict: HistoryContinuationVerdict;
}>;

const LOW_INFORMATION_CLUES: ReadonlySet<string> = new Set([
  "hi",
  "hello",
  "hey",
  "thanks",
  "thank you",
  "thx",
  "okay",
  "yes",
  "yeah",
  "good morning",
  "good evening",
  "good night",
  "bye",
  "goodbye",
  "lol",
  "你好",
  "您好",
  "谢谢",
  "多谢",
  "好的",
  "哈哈",
  "早安",
  "晚安",
  "再见",
  "早上好",
  "晚上好",
  "是的",
]);

export function isLowInformationClue(value: string): boolean {
  return LOW_INFORMATION_CLUES.has(normalizeRetrievalTerm(value));
}

/** Keep the signals the model named that are really available this turn. */
export function validateContinuationBasis(
  claim: HistoryContinuationClaim,
  signals: HistoryContinuationSignals,
): {
  accepted: readonly HistoryContinuationBasis[];
  rejected: readonly HistoryContinuationBasis[];
} {
  const valid = (basis: HistoryContinuationBasis): boolean =>
    basis === "current_input"
      ? signals.currentInputText.trim() !== ""
      : basis === "adjacent_user"
        ? signals.adjacentUserTexts.length > 0
        : signals.dialogueState !== null;
  return {
    accepted: claim.basis.filter(valid),
    rejected: claim.basis.filter((basis) => !valid(basis)),
  };
}

/** Clue groups whose wording appears in the named, valid signals. */
export function anchoredClueGroups(
  plan: Pick<HistoryExperienceSearchPlan, "groups">,
  signals: HistoryContinuationSignals,
  basis: readonly HistoryContinuationBasis[],
): ReadonlySet<number> {
  const texts: string[] = [];
  if (basis.includes("current_input")) texts.push(signals.currentInputText);
  if (basis.includes("adjacent_user")) texts.push(...signals.adjacentUserTexts);
  if (basis.includes("dialogue_state") && signals.dialogueState?.topic) {
    texts.push(signals.dialogueState.topic);
  }
  const haystacks = texts.map((text) => normalizeRetrievalTerm(text));
  const anchored = new Set<number>();
  for (const pattern of searchPatternsOf(plan)) {
    const matcher =
      pattern.kind === "word"
        ? new RegExp(pattern.value)
        : null;
    if (
      haystacks.some((text) =>
        matcher ? matcher.test(text) : text.includes(pattern.value),
      )
    ) {
      anchored.add(pattern.group);
    }
  }
  return anchored;
}

export type ContinuationOccasionEvidence = Readonly<{
  /** Clue groups matched by the occasion's own User messages. */
  matchedGroups: ReadonlySet<number>;
  group: number;
}>;

/**
 * One, a clear leader, tied or too broad. A leader needs strictly more
 * current-talk anchors than every other occasion; query-word overlap alone
 * (support) never makes a leader, because broad clues match everything.
 */
export function assessContinuation(input: {
  anchored: ReadonlySet<number>;
  candidateLimitReached: boolean;
  occasions: readonly ContinuationOccasionEvidence[];
}): Pick<HistoryContinuationCoverage, "leadingGroup" | "occasions" | "verdict"> {
  const occasions = input.occasions.map((occasion) => ({
    anchoredSupport: [...occasion.matchedGroups].filter((id) =>
      input.anchored.has(id),
    ).length,
    group: occasion.group,
    support: occasion.matchedGroups.size,
  }));
  if (occasions.length === 0) {
    return { leadingGroup: null, occasions, verdict: "none" };
  }
  if (occasions.length === 1 && !input.candidateLimitReached) {
    return { leadingGroup: null, occasions, verdict: "single" };
  }
  const best = Math.max(...occasions.map((o) => o.anchoredSupport));
  const leaders = occasions.filter((o) => o.anchoredSupport === best);
  if (best > 0 && leaders.length === 1) {
    return { leadingGroup: leaders[0]!.group, occasions, verdict: "leading" };
  }
  return {
    leadingGroup: null,
    occasions,
    verdict: input.candidateLimitReached ? "too_broad" : "tied",
  };
}

/** Model-facing lines for a continuation result (no private text). */
export function renderContinuationReceiptLines(input: {
  failed: boolean;
  proposal: HistoryExperienceSearchProposal;
  continuation: HistoryContinuationCoverage | undefined;
  occasionDates: readonly Readonly<{ group: number; localDate: string }>[];
}): string[] {
  const verdict = input.failed
    ? "none"
    : (input.continuation?.verdict ?? "none");
  const lines = [
    "The user did not ask about the past: their current message seems to build on something they told you earlier, and the earlier messages quoted below are only that background. Today's message and what they just said come first.",
  ];
  const dateOf = (group: number) =>
    input.occasionDates.find((o) => o.group === group)?.localDate ?? "";
  if (verdict === "single") {
    lines.push(
      "One earlier matter fits. Continue from it naturally if it helps what they just said, without asking them to tell it again. Say only what their earlier words say: do not state or guess how it turned out, and do not ask for progress they have not raised.",
    );
  } else if (verdict === "leading") {
    const group = input.continuation?.leadingGroup ?? 0;
    lines.push(
      `Several earlier matters were found, and occasion ${group} (around ${dateOf(group)}) shares the most with what they are saying now. Treat it as the likely one and continue from it without asking them to retell it; the other occasions are separate matters and must not be merged with it. Say only what their earlier words say; do not state or guess how it turned out.`,
    );
  } else if (verdict === "tied") {
    lines.push(
      "More than one earlier matter fits and nothing in what they are saying separates them. Do not guess, do not pick the most recent one, and do not ask them to tell the whole story again: ask exactly ONE short, natural question that names each matter in a few words (and roughly when), so they can say which. Keep any other reaction brief.",
    );
  } else if (verdict === "too_broad") {
    lines.push(
      "Too many unrelated earlier messages matched to tell what they mean. Do not connect their message to any of them. Reply to what they just said as you normally would; ask one short natural question only if you truly cannot follow without it.",
    );
  } else {
    lines.push(
      "Nothing usable from earlier was found. Reply to what they just said as you normally would. Do not mention any lookup, that you could not find something, or that you cannot remember. If their message cannot be followed without the earlier context, ask one short natural question instead of guessing.",
    );
  }
  lines.push(
    "Do not bring up the earlier background unless it helps what they just said. Never add a new question about how a past matter went, do not make it a task to follow up on, and do not treat the background as the user's current state: it is what they said then.",
  );
  return lines;
}
