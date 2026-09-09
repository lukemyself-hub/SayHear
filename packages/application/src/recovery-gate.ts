import type { UserId } from "@sayhear/domain";

import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
  PURGE_SURFACE_REGISTRY_LEGACY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION,
} from "./purge-surface-registry";
import {
  isValidPurgeMarkerSnapshot,
  markerReceiptsMatchLocalReceipts,
  type OwnerPurgeRepository,
  type PurgeMarkerRepository,
  type PurgeMarkerSnapshot,
} from "./owner-purge";

export type RecoveryBusinessState = Readonly<{
  dataEpoch: number;
  status: "active" | "deleting" | "disabled";
}>;

export type RecoveryGateStatus =
  | "open"
  | "reapply_required"
  | "needs_attention"
  | "unavailable";

export type RecoveryGateResult = Readonly<{
  status: RecoveryGateStatus;
  markerDataEpoch: number | null;
  markerPurgedAt: Date | null;
  markerWrittenAt: Date | null;
  receiptDestinations: readonly string[];
}>;

export type RecoveryBusinessStateRepository = Readonly<{
  findRecoveryBusinessState(
    userId: UserId,
  ): Promise<RecoveryBusinessState | null>;
}>;

type RecoveryPurgeStateRepository = Pick<
  OwnerPurgeRepository,
  "findLatestOrder" | "listReceipts"
> & {
  /**
   * Re-run the data-layer receipt verifier, including provider-specific
   * destinations, from a consistent business-database snapshot. Listing
   * receipts alone is not an independent verification boundary.
   */
  verifyRecoveryReceipts(input: {
    ownerPurgeOrderId: string;
    userId: UserId;
    dataEpoch: number;
  }): Promise<boolean>;
};

function hasCurrentPurgeVersions(order: {
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
}): boolean {
  return (
    order.purgeSurfaceRegistryVersion === PURGE_SURFACE_REGISTRY_VERSION &&
    order.externalIntegrationManifestVersion ===
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION &&
    order.workflowSubjectManifestVersion ===
      PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION
  );
}

function hasLegacyTerminalPurgeVersions(order: {
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
  status: string;
}): boolean {
  return (
    order.status === "retention_pending" &&
    order.purgeSurfaceRegistryVersion === PURGE_SURFACE_REGISTRY_LEGACY_VERSION &&
    order.externalIntegrationManifestVersion ===
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION &&
    order.workflowSubjectManifestVersion ===
      PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION
  );
}

export type RecoveryGate = Readonly<{
  evaluate(userId: UserId): Promise<RecoveryGateResult>;
  requireOpen(userId: UserId): Promise<RecoveryGateResult>;
}>;

export class RecoveryGateClosedError extends Error {
  public constructor(public readonly result: RecoveryGateResult) {
    super(`Private traffic is closed by the recovery gate: ${result.status}.`);
    this.name = "RecoveryGateClosedError";
  }
}

function resultFor(
  status: RecoveryGateStatus,
  marker: PurgeMarkerSnapshot | null,
): RecoveryGateResult {
  return {
    markerDataEpoch: marker?.dataEpoch ?? null,
    markerPurgedAt: marker?.purgedAt ?? null,
    markerWrittenAt: marker?.writtenAt ?? null,
    receiptDestinations:
      marker?.receipts.map((receipt) => receipt.destination) ?? [],
    status,
  };
}

export function createRecoveryGate(dependencies: {
  businessStateRepository: RecoveryBusinessStateRepository;
  markerRepository: Pick<PurgeMarkerRepository, "findLatestMarker">;
  purgeStateRepository?: RecoveryPurgeStateRepository;
}): RecoveryGate {
  return {
    async evaluate(userId) {
      let state: RecoveryBusinessState | null;
      let marker: PurgeMarkerSnapshot | null;
      try {
        [state, marker] = await Promise.all([
          dependencies.businessStateRepository.findRecoveryBusinessState(userId),
          dependencies.markerRepository.findLatestMarker({ userId }),
        ]);
      } catch {
        return resultFor("unavailable", null);
      }

      if (state === null) {
        return resultFor("unavailable", marker);
      }
      if (marker === null) {
        // A clean first-generation database has no purge history. Any
        // non-active state or advanced epoch without its external marker is
        // an inconsistent restored database and must remain closed.
        return resultFor(
          state.status === "active" && state.dataEpoch === 1
            ? "open"
            : "needs_attention",
          marker,
        );
      }
      if (!isValidPurgeMarkerSnapshot(marker)) {
        return resultFor("needs_attention", marker);
      }
      if (state.dataEpoch < marker.dataEpoch) {
        return resultFor("reapply_required", marker);
      }
      if (state.dataEpoch > marker.dataEpoch) {
        return resultFor("needs_attention", marker);
      }
      if (state.status !== "active") {
        return resultFor("needs_attention", marker);
      }
      if (!dependencies.purgeStateRepository) {
        return resultFor("needs_attention", marker);
      }
      try {
        const localOrder = await dependencies.purgeStateRepository.findLatestOrder({
          userId,
        });
        if (
          localOrder === null ||
          localOrder.dataEpoch !== marker.dataEpoch ||
          !["active_system_deleted", "retention_pending"].includes(
            localOrder.status,
          ) ||
          (!hasCurrentPurgeVersions(localOrder) &&
            !hasLegacyTerminalPurgeVersions(localOrder))
        ) {
          return resultFor("needs_attention", marker);
        }
        const localReceipts =
          await dependencies.purgeStateRepository.listReceipts({
            ownerPurgeOrderId: localOrder.ownerPurgeOrderId,
          });
        if (!markerReceiptsMatchLocalReceipts(marker, localReceipts)) {
          return resultFor("needs_attention", marker);
        }
        if (
          !(await dependencies.purgeStateRepository.verifyRecoveryReceipts({
            dataEpoch: marker.dataEpoch,
            ownerPurgeOrderId: localOrder.ownerPurgeOrderId,
            userId,
          }))
        ) {
          return resultFor("needs_attention", marker);
        }
      } catch {
        return resultFor("unavailable", marker);
      }
      return resultFor("open", marker);
    },

    async requireOpen(userId) {
      const result = await this.evaluate(userId);
      if (result.status !== "open") {
        throw new RecoveryGateClosedError(result);
      }
      return result;
    },
  };
}
