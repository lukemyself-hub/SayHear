import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION,
  PURGE_SURFACE_REGISTRY_LEGACY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION,
} from "./purge-surface-registry";
import {
  createRecoveryGate,
} from "./recovery-gate";
import {
  createRecoveryReapplyService,
  RecoveryReapplyConfirmationError,
} from "./recovery-reapply";
import {
  markerReceiptsMatchLocalReceipts,
  type OwnerPurgeOrder,
  type PurgeMarkerSnapshot,
} from "./owner-purge";

const userId = asUserId("11111111-1111-7111-8111-111111111111");
const marker: PurgeMarkerSnapshot = {
  backupRetentionUntil: null,
  dataEpoch: 2,
  purgedAt: new Date("2026-08-16T12:00:00.000Z"),
  receipts: [
    {
      destination: "business_database",
      destinationDisposition: "verified_deleted",
      providerRetentionUntil: null,
    },
  ],
  status: "retention_pending",
  writtenAt: new Date("2026-08-16T12:00:00.000Z"),
};

describe("marker reapply", () => {
  it("requires explicit confirmation and then reopens at the marker epoch", async () => {
    let state: "active" | "deleting" = "active";
    let businessEpoch = 1;
    const localOrder: OwnerPurgeOrder = {
      ownerPurgeOrderId: "reapply-purge-order-1",
      userId,
      fromDataEpoch: 1,
      dataEpoch: marker.dataEpoch,
      status: "retention_pending",
      policyVersion: "owner-full-purge:v1",
      purgeSurfaceRegistryVersion: "purge-surface-registry:v1",
      externalIntegrationManifestVersion:
        "purge-external-integration-manifest:v1",
      workflowSubjectManifestVersion: "purge-workflow-subject-manifest:v1",
      requestedAt: marker.purgedAt,
      accessRevokedAt: marker.purgedAt,
      propagatingAt: marker.purgedAt,
      verifyingAt: marker.purgedAt,
      activeSystemDeletedAt: marker.purgedAt,
      retentionPendingAt: marker.purgedAt,
      needsAttentionAt: null,
      needsAttentionReason: null,
      backupRetentionUntil: null,
    };
    const gate = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: businessEpoch,
          status: state,
        }),
      },
      markerRepository: { findLatestMarker: async () => marker },
      purgeStateRepository: {
        findLatestOrder: async () =>
          businessEpoch === marker.dataEpoch ? localOrder : null,
        listReceipts: async () => [
          {
            backupRetentionUntil: null,
            destination: "business_database",
            destinationDisposition: "verified_deleted",
            providerDisposition: null,
            providerRetentionUntil: null,
            recordedAt: marker.purgedAt,
          },
        ],
        verifyRecoveryReceipts: async () => true,
      },
    });
    let reapplied = false;
    const service = createRecoveryReapplyService({
      clock: () => new Date("2026-08-16T12:00:00.000Z"),
      gate,
      markerRepository: { findLatestMarker: async () => marker },
      repository: {
        reapplyMarker: async (input) => {
          expect(input.dataEpoch).toBe(2);
          expect(input.purgedAt).toEqual(marker.purgedAt);
          expect(input.backupRetentionUntil).toBe(marker.backupRetentionUntil);
          expect(input.receipts).toEqual(marker.receipts);
          reapplied = true;
          businessEpoch = 2;
          state = "active";
          return { outcome: "reapplied" };
        },
      },
    });

    await expect(
      service.reapply({ confirmation: "PURGE", userId }),
    ).rejects.toBeInstanceOf(RecoveryReapplyConfirmationError);
    const result = await service.reapply({ confirmation: "REAPPLY", userId });
    expect(reapplied).toBe(true);
    expect(result.status).toBe("open");
  });

  it("keeps an active same-epoch restore closed when the marker is malformed", async () => {
    const gate = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: marker.dataEpoch,
          status: "active",
        }),
      },
      markerRepository: {
        findLatestMarker: async () => ({ ...marker, receipts: [] }),
      },
    });

    await expect(gate.evaluate(userId)).resolves.toMatchObject({
      status: "needs_attention",
    });
  });

  it("keeps an active same-epoch restore closed until local receipts match the marker", async () => {
    const localOrder: OwnerPurgeOrder = {
      ownerPurgeOrderId: "purge-order-1",
      userId,
      fromDataEpoch: 1,
      dataEpoch: marker.dataEpoch,
      status: "active_system_deleted",
      policyVersion: "owner-full-purge:v1",
      purgeSurfaceRegistryVersion: "purge-surface-registry:v1",
      externalIntegrationManifestVersion:
        "purge-external-integration-manifest:v1",
      workflowSubjectManifestVersion: "purge-workflow-subject-manifest:v1",
      requestedAt: marker.purgedAt,
      accessRevokedAt: marker.purgedAt,
      propagatingAt: marker.purgedAt,
      verifyingAt: marker.purgedAt,
      activeSystemDeletedAt: marker.purgedAt,
      retentionPendingAt: null,
      needsAttentionAt: null,
      needsAttentionReason: null,
      backupRetentionUntil: null,
    };
    const gate = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: marker.dataEpoch,
          status: "active",
        }),
      },
      markerRepository: { findLatestMarker: async () => marker },
      purgeStateRepository: {
        findLatestOrder: async () => localOrder,
        listReceipts: async () => [],
        verifyRecoveryReceipts: async () => true,
      },
    });

    await expect(gate.evaluate(userId)).resolves.toMatchObject({
      status: "needs_attention",
    });
  });

  it("opens a legacy retention-terminal order when its marker receipts match", async () => {
    const localOrder: OwnerPurgeOrder = {
      ownerPurgeOrderId: "legacy-purge-order-1",
      userId,
      fromDataEpoch: 1,
      dataEpoch: marker.dataEpoch,
      status: "retention_pending",
      policyVersion: "owner-full-purge:v1",
      purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_LEGACY_VERSION,
      externalIntegrationManifestVersion:
        PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION,
      workflowSubjectManifestVersion:
        PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION,
      requestedAt: marker.purgedAt,
      accessRevokedAt: marker.purgedAt,
      propagatingAt: marker.purgedAt,
      verifyingAt: marker.purgedAt,
      activeSystemDeletedAt: marker.purgedAt,
      retentionPendingAt: marker.purgedAt,
      needsAttentionAt: null,
      needsAttentionReason: null,
      backupRetentionUntil: null,
    };
    const gate = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: marker.dataEpoch,
          status: "active",
        }),
      },
      markerRepository: { findLatestMarker: async () => marker },
      purgeStateRepository: {
        findLatestOrder: async () => localOrder,
        listReceipts: async () => [
          {
            backupRetentionUntil: null,
            destination: "business_database",
            destinationDisposition: marker.receipts[0]?.destinationDisposition ?? "unknown",
            providerDisposition: null,
          providerRetentionUntil: marker.receipts[0]?.providerRetentionUntil ?? null,
          recordedAt: marker.purgedAt,
        },
      ],
        verifyRecoveryReceipts: async () => true,
      },
    });

    await expect(gate.evaluate(userId)).resolves.toMatchObject({
      status: "open",
    });
  });

  it("rejects receipt reconciliation when provider or backup disposition drifts", () => {
    const providerMarker: PurgeMarkerSnapshot = {
      ...marker,
      backupRetentionUntil: new Date("2026-09-01T12:00:00.000Z"),
      receipts: [
        ...marker.receipts,
        {
          destination: "provider:role",
          destinationDisposition: "retention_pending",
          providerRetentionUntil: new Date("2026-09-01T12:00:00.000Z"),
        },
      ],
    };
    expect(
      markerReceiptsMatchLocalReceipts(providerMarker, [
        {
          backupRetentionUntil: new Date("2026-08-31T12:00:00.000Z"),
          destination: "business_database",
          destinationDisposition: "verified_deleted",
          providerDisposition: null,
          providerRetentionUntil: null,
          recordedAt: marker.purgedAt,
        },
        {
          backupRetentionUntil: null,
          destination: "provider:role",
          destinationDisposition: "retention_pending",
          providerDisposition: "policy_expired",
          providerRetentionUntil: new Date("2026-09-01T12:00:00.000Z"),
          recordedAt: marker.purgedAt,
        },
      ]),
    ).toBe(false);
  });
});
