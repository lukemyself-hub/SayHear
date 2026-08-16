import type { UserId } from "@sayhear/domain";

import type { PurgeMarkerRepository } from "./owner-purge";
import {
  RecoveryGateClosedError,
  type RecoveryGate,
  type RecoveryGateResult,
} from "./recovery-gate";

export type RecoveryReapplyRepository = Readonly<{
  reapplyMarker(input: {
    dataEpoch: number;
    now: Date;
    userId: UserId;
  }): Promise<Readonly<{ outcome: "reapplied" }>>;
}>;

export type RecoveryReapplyService = Readonly<{
  inspect(userId: UserId): Promise<RecoveryGateResult>;
  reapply(input: {
    confirmation: string;
    userId: UserId;
  }): Promise<RecoveryGateResult>;
}>;

export class RecoveryReapplyConfirmationError extends Error {
  public constructor() {
    super(
      'Marker reapply requires the explicit confirmation field {"confirm":"REAPPLY"}.',
    );
    this.name = "RecoveryReapplyConfirmationError";
  }
}

export class RecoveryReapplyNotRequiredError extends Error {
  public constructor(public readonly status: RecoveryGateResult["status"]) {
    super(`Marker reapply is not available while recovery gate is ${status}.`);
    this.name = "RecoveryReapplyNotRequiredError";
  }
}

export function createRecoveryReapplyService(dependencies: {
  clock: () => Date;
  gate: RecoveryGate;
  markerRepository: Pick<PurgeMarkerRepository, "findLatestMarker">;
  repository: RecoveryReapplyRepository;
}): RecoveryReapplyService {
  return {
    inspect(userId) {
      return dependencies.gate.evaluate(userId);
    },

    async reapply(input) {
      if (input.confirmation !== "REAPPLY") {
        throw new RecoveryReapplyConfirmationError();
      }
      const before = await dependencies.gate.evaluate(input.userId);
      if (before.status !== "reapply_required") {
        throw new RecoveryReapplyNotRequiredError(before.status);
      }
      const marker = await dependencies.markerRepository.findLatestMarker({
        userId: input.userId,
      });
      if (marker === null) {
        throw new RecoveryGateClosedError({
          ...before,
          status: "unavailable",
        });
      }
      await dependencies.repository.reapplyMarker({
        dataEpoch: marker.dataEpoch,
        now: dependencies.clock(),
        userId: input.userId,
      });
      return dependencies.gate.requireOpen(input.userId);
    },
  };
}
