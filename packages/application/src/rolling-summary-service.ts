import type { DailySessionId, UserId } from "@sayhear/domain";

import {
  hasContiguousCoverage,
  validateRollingSummaryContent,
  type RollingSummaryCommand,
  type RollingSummaryContent,
  type RollingSummarySource,
} from "./rolling-summary";
import type { RecoveryGate } from "./recovery-gate";

export type RollingSummaryModel = Readonly<{
  compress(input: { sources: readonly RollingSummarySource[]; policyVersion: string; promptVersion: string; modelConfigVersion: string }): Promise<RollingSummaryContent>;
}>;
export type RollingSummaryRepository = Readonly<{
  queueEligible(input: { now: Date; expectedDataEpoch: number; policyVersion: string; promptVersion: string; modelConfigVersion: string }): Promise<number>;
  reconcile(input: { now: Date; maximumClaimAgeMs: number }): Promise<void>;
  loadCommand(input: { commandId: string; now: Date }): Promise<{ command: RollingSummaryCommand; sources: readonly RollingSummarySource[] } | null>;
  publish(input: { command: RollingSummaryCommand; content: RollingSummaryContent; now: Date }): Promise<"published" | "stale">;
  fail(input: { commandId: string; errorCode: string }): Promise<void>;
  stale(input: { commandId: string }): Promise<void>;
}>;
export type RollingSummaryService = Readonly<{
  scanPending(): Promise<{ queued: number }>;
  run(commandId: string): Promise<{ outcome: "published" | "stale" | "failed" }>;
}>;
export function createRollingSummaryService(dependencies: {
  clock: () => Date; repository: RollingSummaryRepository; model: RollingSummaryModel;
  expectedDataEpoch: number; policyVersion: string; promptVersion: string; modelConfigVersion: string;
  maximumClaimAgeMs?: number;
  recoveryGate?: RecoveryGate;
}): RollingSummaryService {
  const maximumClaimAgeMs = dependencies.maximumClaimAgeMs ?? 5 * 60 * 1_000;
  return {
    async scanPending() {
      const now = dependencies.clock();
      await dependencies.repository.reconcile({ now, maximumClaimAgeMs });
      const queued = await dependencies.repository.queueEligible({ now, expectedDataEpoch: dependencies.expectedDataEpoch, policyVersion: dependencies.policyVersion, promptVersion: dependencies.promptVersion, modelConfigVersion: dependencies.modelConfigVersion });
      return { queued };
    },
    async run(commandId) {
      const frozen = await dependencies.repository.loadCommand({ commandId, now: dependencies.clock() });
      if (!frozen) return { outcome: "stale" };
      await dependencies.recoveryGate?.requireOpen(frozen.command.userId);
      if (!hasContiguousCoverage(frozen.command, frozen.sources)) {
        await dependencies.repository.stale({ commandId });
        return { outcome: "stale" };
      }
      try {
        const content = await dependencies.model.compress({
          sources: frozen.sources,
          policyVersion: frozen.command.policyVersion,
          promptVersion: frozen.command.promptVersion,
          modelConfigVersion: frozen.command.modelConfigVersion,
        });
        validateRollingSummaryContent(content);
        return { outcome: await dependencies.repository.publish({ command: frozen.command, content, now: dependencies.clock() }) };
      } catch {
        await dependencies.repository.fail({ commandId, errorCode: "summary_generation_failed" });
        return { outcome: "failed" };
      }
    },
  };
}
