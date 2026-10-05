import { asDailySessionId, asUserId, type DailySessionId } from "@sayhear/domain";

import type { RecoveryGate } from "./recovery-gate";

export type EvidenceLocatorType = "whole_revision" | "segment" | "text_span" | "time_range";
export type EvidenceRole = "factual_support" | "subjective_report";
export type EvidenceExtractionProvider = Readonly<{
  role: "evidence.extract";
  extract(input: {
    locale: string;
    sourceText: string;
    /**
     * Trusted transport scope threaded from the freeze transaction (owner +
     * Daily Session). A transport that needs an opaque Provider session
     * identity derives one from this; it is deliberately separate from
     * `locale`/`sourceText` so the owner and Daily Session id never enter the
     * model-visible payload. Optional for deterministic and Responses-API
     * extractors that have no such concept.
     */
    transport?: Readonly<{
      dailySessionId: string;
      userId: string;
    }>;
  }): Promise<ReadonlyArray<Readonly<{
    locatorType: EvidenceLocatorType;
    locatorKey: string;
    role: EvidenceRole;
  }>>>;
}>;
export type EvidenceChampion = Readonly<{
  configVersion: string;
  model: string;
  provider: "openai" | "deepseek" | "opencode-go";
  providerPolicyVersion: string;
  snapshot: string;
}>;
export type EvidenceItem = Readonly<{
  id: string;
  userId: string;
  sourceSnapshotId: string;
  sourceRevisionId: string;
  sourceEventId: string;
  sourceActor: "user";
  sourceStatus: "final" | "corrected";
  locatorType: EvidenceLocatorType;
  locatorKey: string;
  extractionPolicyVersion: string;
  role: EvidenceRole;
  status: "active";
}>;
export type EvidenceSourceSnapshot = Readonly<{
  id: string;
  dailySessionId: DailySessionId;
  userId: string;
  sourceRevision: number;
  extractionPolicyVersion: string;
  commandId: string;
  attemptId: string;
  champion: EvidenceChampion;
  evidenceItems: readonly EvidenceItem[];
}>;
export type EvidenceRepository = Readonly<{
  freezeUserEvidence(input: {
    dailySessionId: DailySessionId;
    sourceRevision: number;
    extractionPolicyVersion: string;
    expectedDataEpoch: number;
    commandId: string;
    attemptId: string;
    champion: EvidenceChampion;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "frozen"; snapshot: EvidenceSourceSnapshot }>
    | Readonly<{ outcome: "not_found" }>
    | Readonly<{ outcome: "stale" }>
    | Readonly<{ outcome: "not_eligible" }>
    | Readonly<{ outcome: "writes_disabled" }>
  >;
  findEvidenceSnapshot(input: { dailySessionId: DailySessionId; sourceRevision: number }): Promise<EvidenceSourceSnapshot | null>;
}>;
export type EvidenceService = Readonly<{
  freeze(input: { dailySessionId: string; sourceRevision: number; expectedDataEpoch: number; commandId: string; attemptId: string }): ReturnType<EvidenceRepository["freezeUserEvidence"]>;
  inspect(input: { dailySessionId: string; sourceRevision: number }): Promise<EvidenceSourceSnapshot | null>;
}>;

export function createEvidenceService(dependencies: {
  clock: () => Date;
  extractionPolicyVersion: string;
  champion: EvidenceChampion;
  repository: EvidenceRepository;
  recoveryGate?: RecoveryGate;
  writesEnabled?: boolean;
}): EvidenceService {
  if (!dependencies.extractionPolicyVersion) throw new Error("extractionPolicyVersion must be non-empty.");
  if (!dependencies.champion.configVersion || !dependencies.champion.providerPolicyVersion) throw new Error("Evidence Champion versions must be non-empty.");
  return {
    async freeze(input) {
      if (dependencies.writesEnabled === false) {
        return { outcome: "writes_disabled" } as const;
      }
      if (!Number.isInteger(input.expectedDataEpoch) || input.expectedDataEpoch <= 0) {
        return { outcome: "stale" } as const;
      }
      let dailySessionId: DailySessionId;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return { outcome: "not_found" }; }
      const result = await dependencies.repository.freezeUserEvidence({
        dailySessionId, sourceRevision: input.sourceRevision,
        extractionPolicyVersion: dependencies.extractionPolicyVersion,
        expectedDataEpoch: input.expectedDataEpoch,
        commandId: input.commandId, attemptId: input.attemptId,
        champion: dependencies.champion, now: dependencies.clock(),
      });
      if (result.outcome === "frozen") {
        await dependencies.recoveryGate?.requireOpen(asUserId(result.snapshot.userId));
      }
      return result;
    },
    async inspect(input) {
      let dailySessionId: DailySessionId;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return null; }
      return dependencies.repository.findEvidenceSnapshot({ dailySessionId, sourceRevision: input.sourceRevision });
    },
  };
}
