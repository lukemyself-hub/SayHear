import type { ConversationEventRevisionId, DailySessionId, UserId } from "@sayhear/domain";

export type RollingSummaryContent = Readonly<{
  statedFacts: readonly string[];
  judgmentsAndFeelings: readonly string[];
  openTopics: readonly string[];
}>;
export type CurrentRollingSummary = Readonly<{
  id: string; version: number; coveredThrough: number;
  sourceRevisionIds: readonly ConversationEventRevisionId[];
  content: RollingSummaryContent;
  policyVersion: string; promptVersion: string; modelConfigVersion: string;
}>;
export type RollingSummarySource = Readonly<{
  revisionId: ConversationEventRevisionId;
  sequence: number;
  actor: "user" | "assistant";
  text: string;
}>;
export type RollingSummaryCommand = Readonly<{
  id: string; userId: UserId; dailySessionId: DailySessionId; expectedDataEpoch: number;
  sourceRevision: number; dialogueRevision: number; coverageStart: number; coveredThrough: number;
  policyVersion: string; minimumUncoveredEventCount: number; minimumUncoveredTokenCount: number;
  promptVersion: string; modelConfigVersion: string;
}>;
export function validateRollingSummaryContent(value: RollingSummaryContent): void {
  const items = [...value.statedFacts, ...value.judgmentsAndFeelings, ...value.openTopics];
  if (items.length > 24 || items.some((item) => !item.trim() || item.length > 1_000)) {
    throw new Error("Rolling Summary content violates the bounded structured policy.");
  }
}
export function hasContiguousCoverage(command: RollingSummaryCommand, sources: readonly RollingSummarySource[]): boolean {
  return sources.length > 0 && sources.every((source, index) => source.sequence === command.coverageStart + index) && sources.at(-1)?.sequence === command.coveredThrough;
}
