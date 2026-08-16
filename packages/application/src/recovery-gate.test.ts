import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  createRecoveryGate,
  type RecoveryBusinessState,
} from "./recovery-gate";
import type { PurgeMarkerSnapshot } from "./owner-purge";

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
});
