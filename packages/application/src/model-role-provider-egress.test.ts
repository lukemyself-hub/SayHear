import { describe, expect, it, vi } from "vitest";

import {
  asGenerationCommandId,
  asModelRunAttemptId,
  asUserId,
} from "@sayhear/domain";

import {
  createModelRoleProviderEgress,
  type ModelRoleCommandService,
  type ModelRoleProviderDispatchInput,
} from "./model-role-runtime";
import { RecoveryGateClosedError, type RecoveryGate } from "./recovery-gate";

const dispatchInput: ModelRoleProviderDispatchInput<string> = {
  userId: asUserId("01984477-2f9a-7b25-a5cc-83c3b21fbc68"),
  generationCommandId: asGenerationCommandId(
    "01984477-3f9a-7b25-a5cc-83c3b21fbc68",
  ),
  modelRunAttemptId: asModelRunAttemptId(
    "01984477-4f9a-7b25-a5cc-83c3b21fbc68",
  ),
  role: "episode.build",
  attemptNo: 1,
  attemptKind: "initial",
  rolloutPin: "rollout:v1",
  currentSourceRevision: 4,
  expectedDataEpoch: 2,
  now: new Date("2026-09-10T20:00:00.000Z"),
  execute: async () => "provider-result",
};

function openGate(): RecoveryGate {
  return {
    evaluate: async () => ({
      status: "open",
      markerDataEpoch: null,
      markerPurgedAt: null,
      markerWrittenAt: null,
      receiptDestinations: [],
    }),
    requireOpen: async () => ({
      status: "open",
      markerDataEpoch: null,
      markerPurgedAt: null,
      markerWrittenAt: null,
      receiptDestinations: [],
    }),
  };
}

function commandService(
  claimProviderDispatch: ModelRoleCommandService["claimProviderDispatch"],
  discardAttempt: ModelRoleCommandService["discardAttempt"] = vi.fn(
    async () => ({
      outcome: "discarded" as const,
      reason: "recovery_closed" as const,
      generationCommandId: dispatchInput.generationCommandId,
      modelRunAttemptId: dispatchInput.modelRunAttemptId,
    }),
  ),
): Pick<ModelRoleCommandService, "claimProviderDispatch" | "discardAttempt"> {
  return { claimProviderDispatch, discardAttempt };
}

describe("model-role Provider Egress", () => {
  it("claims the frozen attempt before executing the provider callback", async () => {
    const claimProviderDispatch = vi.fn(async () => ({ outcome: "ready" as const }));
    const execute = vi.fn(async () => "provider-result");
    const egress = createModelRoleProviderEgress({
      commandService: commandService(claimProviderDispatch),
      recoveryGate: openGate(),
    });

    await expect(egress.dispatch({ ...dispatchInput, execute })).resolves.toBe(
      "provider-result",
    );
    expect(claimProviderDispatch).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("does not cross the provider boundary when the database claim is fenced", async () => {
    const claimProviderDispatch = vi.fn(async () => ({
      outcome: "discarded" as const,
      reason: "rollout_pin_changed" as const,
    }));
    const execute = vi.fn(async () => "provider-result");
    const egress = createModelRoleProviderEgress({
      commandService: commandService(claimProviderDispatch),
      recoveryGate: openGate(),
    });

    await expect(egress.dispatch({ ...dispatchInput, execute })).rejects.toThrow(
      "lost its Provider dispatch fence",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("discards the attempt and blocks dispatch when recovery closes first", async () => {
    const discardAttempt = vi.fn(async () => ({
      outcome: "discarded" as const,
      reason: "recovery_closed" as const,
      generationCommandId: dispatchInput.generationCommandId,
      modelRunAttemptId: dispatchInput.modelRunAttemptId,
    }));
    const execute = vi.fn(async () => "provider-result");
    const gate: RecoveryGate = {
      ...openGate(),
      requireOpen: async () => {
        throw new RecoveryGateClosedError({
          status: "needs_attention",
          markerDataEpoch: 2,
          markerPurgedAt: null,
          markerWrittenAt: null,
          receiptDestinations: [],
        });
      },
    };
    const egress = createModelRoleProviderEgress({
      commandService: commandService(vi.fn(), discardAttempt),
      recoveryGate: gate,
    });

    await expect(egress.dispatch({ ...dispatchInput, execute })).rejects.toThrow(
      "recovery gate closed",
    );
    expect(discardAttempt).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rechecks the source head after claiming and before the provider callback", async () => {
    const claimProviderDispatch = vi.fn(async () => ({ outcome: "ready" as const }));
    const discardAttempt = vi.fn(async () => ({
      outcome: "discarded" as const,
      reason: "source_changed" as const,
      generationCommandId: dispatchInput.generationCommandId,
      modelRunAttemptId: dispatchInput.modelRunAttemptId,
    }));
    const sourceIsCurrent = vi.fn(async () => false);
    const execute = vi.fn(async () => "provider-result");
    const egress = createModelRoleProviderEgress({
      commandService: commandService(claimProviderDispatch, discardAttempt),
      recoveryGate: openGate(),
    });

    await expect(
      egress.dispatch({ ...dispatchInput, execute, sourceIsCurrent }),
    ).rejects.toThrow("source changed");
    expect(sourceIsCurrent).toHaveBeenCalledOnce();
    expect(discardAttempt).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});
