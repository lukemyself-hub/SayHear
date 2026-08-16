import {
  evaluatePrivateWriteGate,
  type BackupPolicyEvidence,
  type PrivateWriteGateStatus,
  type UserId,
} from "@sayhear/domain";

import type { RecoveryBusinessState } from "./recovery-gate";
import type { RecoveryGate } from "./recovery-gate";

export type InternalOwnerAccessRepository = Readonly<{
  findActiveOwner(userId: UserId): Promise<{ userId: UserId } | null>;
  findInternalOwner(userId: UserId): Promise<{ userId: UserId } | null>;
  findRecoveryBusinessState?(userId: UserId): Promise<RecoveryBusinessState | null>;
  findLatestBackupPolicyEvidence(): Promise<BackupPolicyEvidence | null>;
}>;

export type InternalOwnerAccessService = Readonly<{
  assertOperator(userId: UserId): Promise<void>;
  getAccess(userId: UserId): Promise<{
    privateWrites: PrivateWriteGateStatus;
  }>;
}>;

export class InternalOwnerAccessDeniedError extends Error {
  public constructor() {
    super("The authenticated principal is not the active Internal Owner.");
    this.name = "InternalOwnerAccessDeniedError";
  }
}

export function createInternalOwnerAccessService(dependencies: {
  clock: () => Date;
  expectedBackupPolicyVersion: string;
  expectedConfigurationFingerprint: string;
  recoveryGate?: RecoveryGate;
  repository: InternalOwnerAccessRepository;
}): InternalOwnerAccessService {
  return {
    async assertOperator(userId) {
      const owner = await dependencies.repository.findInternalOwner(userId);
      if (owner === null) {
        throw new InternalOwnerAccessDeniedError();
      }
    },
    async getAccess(userId) {
      const owner = await dependencies.repository.findActiveOwner(userId);
      if (owner === null) {
        throw new InternalOwnerAccessDeniedError();
      }

      await dependencies.recoveryGate?.requireOpen(userId);

      const evidence =
        await dependencies.repository.findLatestBackupPolicyEvidence();

      return {
        privateWrites: evaluatePrivateWriteGate({
          evidence,
          expectedConfigurationFingerprint:
            dependencies.expectedConfigurationFingerprint,
          expectedPolicyVersion: dependencies.expectedBackupPolicyVersion,
          now: dependencies.clock(),
        }),
      };
    },
  };
}
