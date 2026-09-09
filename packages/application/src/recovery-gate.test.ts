import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  createRecoveryGate,
  type RecoveryBusinessState,
} from "./recovery-gate";
import type { OwnerPurgeOrder, PurgeMarkerSnapshot } from "./owner-purge";

const userId = asUserId("11111111-1111-7111-8111-111111111111");
const timestamp = new Date("2026-08-16T12:00:00.000Z");

function marker(dataEpoch: number): PurgeMarkerSnapshot {
  return {
    backupRetentionUntil: null,
    dataEpoch,
    purgedAt: timestamp,
    receipts: [
      {
        destination: "business_database",
        destinationDisposition: "verified_deleted",
        providerRetentionUntil: null,
      },
    ],
    status: "retention_pending",
    writtenAt: timestamp,
  };
}

function gate(state: RecoveryBusinessState | null, current: PurgeMarkerSnapshot | null) {
  return createRecoveryGate({
    businessStateRepository: {
      findRecoveryBusinessState: async () => state,
    },
    markerRepository: {
      findLatestMarker: async () => current,
    },
  });
}

describe("Recovery Gate", () => {
  it("opens a clean first-generation active database without a marker", async () => {
    await expect(
      gate({ dataEpoch: 1, status: "active" }, null).evaluate(userId),
    ).resolves.toMatchObject({ status: "open" });
  });

  it("requires marker reapply for an older restored database", async () => {
    const result = await gate(
      { dataEpoch: 1, status: "active" },
      marker(2),
    ).evaluate(userId);
    expect(result).toMatchObject({
      markerDataEpoch: 2,
      status: "reapply_required",
    });
  });

  it("fails closed when a restored database has purge history but the marker is missing", async () => {
    await expect(
      gate({ dataEpoch: 2, status: "active" }, null).evaluate(userId),
    ).resolves.toMatchObject({ status: "needs_attention" });
  });

  it("fails closed for reverse inconsistency and marker-store failure", async () => {
    await expect(
      gate({ dataEpoch: 3, status: "active" }, marker(2)).requireOpen(userId),
    ).rejects.toMatchObject({ result: { status: "needs_attention" } });

    const unavailable = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => {
          throw new Error("marker store unavailable");
        },
      },
      markerRepository: {
        findLatestMarker: async () => marker(2),
      },
    });
    await expect(unavailable.evaluate(userId)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("fails closed when the independent provider receipt verifier rejects", async () => {
    const localOrder: OwnerPurgeOrder = {
      ownerPurgeOrderId: "recovery-verified-purge-order",
      userId,
      fromDataEpoch: 1,
      dataEpoch: 2,
      status: "retention_pending",
      policyVersion: "owner-full-purge:v1",
      purgeSurfaceRegistryVersion: "purge-surface-registry:v1",
      externalIntegrationManifestVersion:
        "purge-external-integration-manifest:v1",
      workflowSubjectManifestVersion: "purge-workflow-subject-manifest:v1",
      requestedAt: timestamp,
      accessRevokedAt: timestamp,
      propagatingAt: timestamp,
      verifyingAt: timestamp,
      activeSystemDeletedAt: timestamp,
      retentionPendingAt: timestamp,
      needsAttentionAt: null,
      needsAttentionReason: null,
      backupRetentionUntil: null,
    };
    const result = await createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: 2,
          status: "active" as const,
        }),
      },
      markerRepository: { findLatestMarker: async () => marker(2) },
      purgeStateRepository: {
        findLatestOrder: async () => localOrder,
        listReceipts: async () => [
          {
            backupRetentionUntil: null,
            destination: "business_database",
            destinationDisposition: "verified_deleted",
            providerDisposition: null,
            providerRetentionUntil: null,
            recordedAt: timestamp,
          },
        ],
        verifyRecoveryReceipts: async () => false,
      },
    }).evaluate(userId);

    expect(result).toMatchObject({ status: "needs_attention" });
  });
});
