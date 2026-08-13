import { asDailySessionId, type DailySessionId } from "@sayhear/domain";

export type EvidenceLocatorType = "whole_revision" | "segment" | "text_span" | "time_range";
export type EvidenceRole = "factual_support" | "subjective_report";
export type EvidenceExtractionProvider = Readonly<{
  role: "evidence.extract";
  extract(input: { locale: string; sourceText: string }): Promise<ReadonlyArray<Readonly<{
    locatorType: EvidenceLocatorType;
    locatorKey: string;
    role: EvidenceRole;
  }>>>;
}>;
export type EvidenceChampion = Readonly<{
  configVersion: string;
  model: string;
  provider: "openai" | "deepseek";
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
  freeze(input: { dailySessionId: string; sourceRevision: number; commandId: string; attemptId: string }): ReturnType<EvidenceRepository["freezeUserEvidence"]>;
  inspect(input: { dailySessionId: string; sourceRevision: number }): Promise<EvidenceSourceSnapshot | null>;
}>;

export function createEvidenceService(dependencies: {
  clock: () => Date;
  expectedDataEpoch: number;
  extractionPolicyVersion: string;
  champion: EvidenceChampion;
  repository: EvidenceRepository;
  writesEnabled?: boolean;
}): EvidenceService {
  if (!dependencies.extractionPolicyVersion) throw new Error("extractionPolicyVersion must be non-empty.");
  if (!Number.isInteger(dependencies.expectedDataEpoch) || dependencies.expectedDataEpoch <= 0) throw new Error("expectedDataEpoch must be a positive integer.");
  if (!dependencies.champion.configVersion || !dependencies.champion.providerPolicyVersion) throw new Error("Evidence Champion versions must be non-empty.");
  return {
    async freeze(input) {
      if (dependencies.writesEnabled === false) {
        return { outcome: "writes_disabled" } as const;
      }
      let dailySessionId: DailySessionId;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return { outcome: "not_found" }; }
      return dependencies.repository.freezeUserEvidence({
        dailySessionId, sourceRevision: input.sourceRevision,
        extractionPolicyVersion: dependencies.extractionPolicyVersion,
        expectedDataEpoch: dependencies.expectedDataEpoch,
        commandId: input.commandId, attemptId: input.attemptId,
        champion: dependencies.champion, now: dependencies.clock(),
      });
    },
    async inspect(input) {
      let dailySessionId: DailySessionId;
      try { dailySessionId = asDailySessionId(input.dailySessionId); } catch { return null; }
      return dependencies.repository.findEvidenceSnapshot({ dailySessionId, sourceRevision: input.sourceRevision });
    },
  };
}
