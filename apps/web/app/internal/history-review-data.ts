import type {
  HistoryRecallInspection,
  TurnInspection,
} from "@sayhear/application";

/**
 * Pure shaping for the history-review panel of the Context Inspector (#320).
 * Everything here reads recorded, content-free fields; nothing is re-read or
 * recomputed from history.
 */

export type HistoryReadState = "complete" | "empty" | "failed" | "none" | "partial";

/**
 * The plain state of the history read, from the recorded result only. An empty
 * read is a fully enumerated range that held nothing; it is never inferred from
 * a missing section.
 */
export function historyReadState(
  historyRecall: HistoryRecallInspection | null | undefined,
): HistoryReadState {
  if (!historyRecall) return "none";
  if (historyRecall.status === "failed") return "failed";
  if (historyRecall.status === "partial") return "partial";
  return historyRecall.sources.length === 0 &&
    historyRecall.coverage.enumerationComplete === true
    ? "empty"
    : "complete";
}

export function historyPlanSummary(
  plan: HistoryRecallInspection["plan"] | undefined,
): string {
  if (plan === null || plan === undefined) return "No plan could be resolved.";
  if ("termGroups" in plan) {
    const range =
      plan.startDate === null
        ? "no date limit"
        : `${plan.startDate} → ${plan.endDate ?? plan.startDate}`;
    return `Original-text search: ${plan.termGroups} term group(s), ${plan.personGroups} person group(s), ${plan.variants} variant(s), ${range}, ${plan.timezone}. The clues themselves are not shown.`;
  }
  return `Date review: ${plan.startDate} → ${plan.endDate} (${plan.timeBasis === "experienced_date" ? "when it happened" : "when it was said"}), ${plan.timezone}.`;
}

export const TURN_DISPOSITION_LABEL: Readonly<Record<string, string>> = {
  committed: "Committed as one complete reply",
  failed: "Failed; nothing was committed",
  in_progress: "Still in progress",
  interrupted: "Interrupted; shown text was never committed",
  settled_without_reply: "Settled without a reply",
};

export function turnDispositionLabel(
  turn: TurnInspection | null | undefined,
): string {
  if (!turn) return "Ordinary reply";
  return TURN_DISPOSITION_LABEL[turn.finalDisposition] ?? turn.finalDisposition;
}

/**
 * What the person at the Inspector is told when the original words stay
 * closed. It never repeats a query, a person or a date range.
 */
export function describeOriginalWordsDenial(error: string | null): string {
  if (error === "recent_step_up_required") {
    return "Opening original words needs a recent step-up. Confirm it, then try again.";
  }
  if (error === "elevated_capability_required") {
    return "This session does not have the content-reading capability, so the original words stay closed.";
  }
  return "The original words could not be opened.";
}
