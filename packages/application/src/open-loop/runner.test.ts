import { describe, expect, it, vi } from "vitest";

import {
  asEvidenceItemId,
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  createOpenLoopExtractionScanService,
  runOpenLoopExtractAttempt,
  type OpenLoopExtractAttemptCommand,
  type OpenLoopExtractionRepository,
  type OpenLoopExtractionSnapshot,
} from "./runner";
import type {
  ModelRoleCommandService,
  OpenLoopExtractModelProvider,
} from "../index";

const userId = asUserId("01984477-1f9a-7b25-a5cc-83c3b21fbc68");
const generationCommandId = asGenerationCommandId(
  "01984477-3f9a-7b25-a5cc-83c3b21fbc68",
);
const modelRunAttemptId = asModelRunAttemptId(
  "01984477-4f9a-7b25-a5cc-83c3b21fbc68",
);
const evidenceItemId = asEvidenceItemId(
  "01984477-5f9a-7b25-a5cc-83c3b21fbc68",
);
const eventRevisionId = "01984477-2f9a-7b25-a5cc-83c3b21fbc68";

const snapshot: OpenLoopExtractionSnapshot = {
  userId,
  eventRevisionId,
  sourceRevision: 3,
  expectedDataEpoch: 2,
  locale: "en-US",
  timeZone: "America/Los_Angeles",
  userText: "My flight to Berlin is next Friday.",
  evidenceCommittedAt: "2026-09-15T10:00:00.000Z",
  evidence: [
    {
      evidenceItemId,
      revisionId: "revision-1",
      locatorType: "whole_revision",
      locatorKey: "revision:revision-1",
      committedAt: "2026-09-15T10:00:00.000Z",
    },
  ],
  identityCandidates: [],
  currentOpenCount: 0,
};

const command: OpenLoopExtractAttemptCommand = {
  workflowCommandId: "01984477-6f9a-7b25-a5cc-83c3b21fbc68",
  eventRevisionId,
  sourceRevision: 3,
  generationCommandId: String(generationCommandId),
  modelRunAttemptId: String(modelRunAttemptId),
  attemptNo: 1,
  attemptKind: "initial",
  rolloutPin: "open_loop.extract-rollout:v1",
  policyVersion: "open-loop-extraction:v1",
  expectedDataEpoch: 2,
};

function repository(
  overrides: Partial<OpenLoopExtractionRepository> = {},
): OpenLoopExtractionRepository {
  return {
    listEventsNeedingExtraction: async () => [],
    readExtractionSnapshot: async () => ({ outcome: "ready", snapshot }),
    readAttemptEventRevision: async () => ({
      outcome: "ready",
      eventRevisionId,
    }),
    commitEventEffects: async () => ({
      outcome: "settled",
      formed: 1,
      closed: 0,
      suppressed: 0,
    }),
    ...overrides,
  };
}

function commandService(
  overrides: Partial<ModelRoleCommandService> = {},
): ModelRoleCommandService {
  return {
    admit: async () => ({
      outcome: "created" as const,
      generationCommandId,
      modelRunAttemptId,
      workflowCommandId: null,
      attemptNo: 1,
      attemptKind: "initial" as const,
      intentKey: `open_loop.extract:1a3b:digest`,
    }),
    configuration: () => null,
    validateAttempt: async () => ({ outcome: "ready" as const }),
    claimProviderDispatch: async () => ({ outcome: "ready" as const }),
    discardAttempt: async () => ({
      outcome: "discarded" as const,
      reason: "already_settled" as const,
      generationCommandId,
      modelRunAttemptId,
    }),
    recordAttemptResult: async () => ({
      outcome: "succeeded" as const,
      generationCommandId,
      modelRunAttemptId,
    }),
    ...overrides,
  };
}

function provider(
  output: Awaited<
    ReturnType<OpenLoopExtractModelProvider["extractProposals"]>
  >,
): OpenLoopExtractModelProvider {
  return {
    role: "open_loop.extract",
    extractProposals: async () => output,
  };
}

const validProposal = {
  kind: "upcoming_event",
  evidenceItemId,
  evidenceRevisionId: "revision-1",
  hasRealAnchor: true,
  isTaskLike: false,
  userTimeExpression: "next Friday",
  expectedWindow: null,
  proposalIndex: 0,
} as const;

describe("open_loop.extract runner", () => {
  type CommitInput = Parameters<
    OpenLoopExtractionRepository["commitEventEffects"]
  >[0];
  type CommitResult = Awaited<
    ReturnType<OpenLoopExtractionRepository["commitEventEffects"]>
  >;
  const commitMock = (result: CommitResult) =>
    vi.fn(async (_input: CommitInput): Promise<CommitResult> => result);

  it("commits deterministic effects and settles the attempt on success", async () => {
    const commitEventEffects = commitMock({
      outcome: "settled",
      formed: 1,
      closed: 0,
      suppressed: 0,
    });
    const recordAttemptResult = vi.fn(async () => ({
      outcome: "succeeded" as const,
      generationCommandId,
      modelRunAttemptId,
    }));
    const extractProposals = vi.fn(async () => ({
      proposals: [validProposal],
      closures: [],
    }));

    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository({ commitEventEffects }),
      modelRoleCommandService: commandService({ recordAttemptResult }),
      openLoopExtractProvider: {
        role: "open_loop.extract",
        extractProposals,
      },
      command,
    });

    expect(result).toMatchObject({
      outcome: "extracted",
      formedCount: 1,
      closedCount: 0,
      skippedCount: 0,
      errorCode: null,
    });
    expect(extractProposals).toHaveBeenCalledOnce();
    expect(commitEventEffects).toHaveBeenCalledOnce();
    const commit = commitEventEffects.mock.calls[0]?.[0];
    expect(commit?.formations).toHaveLength(1);
    expect(commit?.formations[0]).toMatchObject({
      kind: "upcoming_event",
      sourceEventRevisionId: eventRevisionId,
      localizedSummary: null,
      reuseOpenLoopId: null,
    });
    expect(recordAttemptResult).toHaveBeenCalledOnce();
  });

  it("leaves a stale event alone without calling the provider", async () => {
    const extractProposals = vi.fn(async () => ({
      proposals: [],
      closures: [],
    }));
    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository({
        readExtractionSnapshot: async () => ({ outcome: "stale" }),
      }),
      modelRoleCommandService: commandService(),
      openLoopExtractProvider: {
        role: "open_loop.extract",
        extractProposals,
      },
      command,
    });

    expect(result.outcome).toBe("stale_superseded");
    expect(extractProposals).not.toHaveBeenCalled();
  });

  it("skips proposals citing unknown evidence but still commits the rest", async () => {
    const commitEventEffects = commitMock({
      outcome: "settled",
      formed: 0,
      closed: 0,
      suppressed: 0,
    });
    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository({ commitEventEffects }),
      modelRoleCommandService: commandService(),
      openLoopExtractProvider: provider({
        proposals: [
          {
            ...validProposal,
            evidenceItemId: asEvidenceItemId(
              "01984477-9f9a-7b25-a5cc-83c3b21fbc68",
            ),
          },
        ],
        closures: [],
      }),
      command,
    });

    expect(result).toMatchObject({ outcome: "extracted", skippedCount: 1 });
    expect(commitEventEffects.mock.calls[0]?.[0].formations).toHaveLength(0);
  });

  it("maps a provider timeout onto a retryable attempt result", async () => {
    const recordAttemptResult = vi.fn(async () => ({
      outcome: "retry_scheduled" as const,
      generationCommandId,
      modelRunAttemptId,
    }));
    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository(),
      modelRoleCommandService: commandService({ recordAttemptResult }),
      openLoopExtractProvider: {
        role: "open_loop.extract",
        extractProposals: async () => {
          const error = new Error("Provider timed out.");
          (error as { category?: string }).category = "timeout";
          throw error;
        },
      },
      command,
    });

    expect(result).toMatchObject({
      outcome: "retryable_failed",
      errorCode: "timeout",
    });
    expect(recordAttemptResult).toHaveBeenCalledOnce();
  });

  it("reports a duplicate commit without settling twice", async () => {
    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository({
        commitEventEffects: async () => ({
          outcome: "already_settled",
          formed: 1,
          closed: 0,
          suppressed: 0,
        }),
      }),
      modelRoleCommandService: commandService(),
      openLoopExtractProvider: provider({
        proposals: [validProposal],
        closures: [],
      }),
      command,
    });

    expect(result).toMatchObject({ outcome: "duplicate", formedCount: 1 });
  });

  it("fences the attempt when the domain commit is fenced", async () => {
    type RecordInput = Parameters<
      ModelRoleCommandService["recordAttemptResult"]
    >[0];
    type RecordResult = Awaited<
      ReturnType<ModelRoleCommandService["recordAttemptResult"]>
    >;
    const recordAttemptResult = vi.fn(
      async (_input: RecordInput): Promise<RecordResult> => ({
        outcome: "succeeded",
        generationCommandId,
        modelRunAttemptId,
      }),
    );
    const result = await runOpenLoopExtractAttempt({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      repository: repository({
        commitEventEffects: async () => ({
          outcome: "fenced",
          reason: "data_epoch",
        }),
      }),
      modelRoleCommandService: commandService({ recordAttemptResult }),
      openLoopExtractProvider: provider({
        proposals: [validProposal],
        closures: [],
      }),
      command,
    });

    expect(result).toMatchObject({ outcome: "fenced", errorCode: "data_epoch" });
    expect(recordAttemptResult.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed",
      failureCode: "business_fence",
    });
  });
});

describe("open_loop.extract scan", () => {
  it("stays closed until the G2 switches open the lane", async () => {
    const admit = vi.fn();
    const service = createOpenLoopExtractionScanService({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      policyVersion: "open-loop-extraction:v1",
      repository: repository(),
      modelRoleCommandService: commandService({ admit }),
      enabled: false,
    });

    await expect(service.scanPending()).resolves.toEqual({
      extractionsQueued: 0,
    });
    expect(admit).not.toHaveBeenCalled();
  });

  it("admits one idempotent command per pending event", async () => {
    type AdmitInput = Parameters<ModelRoleCommandService["admit"]>[0];
    type AdmitResult = Awaited<ReturnType<ModelRoleCommandService["admit"]>>;
    const admitted = (outcome: "created" | "reused"): AdmitResult => ({
      outcome,
      generationCommandId,
      modelRunAttemptId,
      workflowCommandId: null,
      attemptNo: 1,
      attemptKind: "initial",
      intentKey: "open_loop.extract:1a3b:digest",
    });
    const admit = vi.fn(
      async (_input: AdmitInput): Promise<AdmitResult> =>
        admitted("created"),
    );
    admit.mockResolvedValueOnce(admitted("created"));
    admit.mockResolvedValueOnce(admitted("reused"));
    const service = createOpenLoopExtractionScanService({
      clock: () => new Date("2026-09-15T10:00:00.000Z"),
      policyVersion: "open-loop-extraction:v1",
      repository: repository({
        listEventsNeedingExtraction: async () => [
          {
            eventRevisionId: "revision-a",
            userId,
            sourceRevision: 3,
            expectedDataEpoch: 2,
          },
          {
            eventRevisionId: "revision-b",
            userId,
            sourceRevision: 4,
            expectedDataEpoch: 2,
          },
        ],
      }),
      modelRoleCommandService: commandService({ admit }),
      enabled: true,
    });

    await expect(service.scanPending()).resolves.toEqual({
      extractionsQueued: 1,
    });
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit.mock.calls[0]?.[0]).toMatchObject({
      role: "open_loop.extract",
      subjectType: "conversation_event_revision",
      subjectId: "revision-a",
    });
  });
});
