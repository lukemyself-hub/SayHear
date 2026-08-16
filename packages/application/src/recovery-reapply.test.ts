import { describe, expect, it } from "vitest";

import { asUserId } from "@sayhear/domain";

import {
  createRecoveryGate,
} from "./recovery-gate";
import {
  createRecoveryReapplyService,
  RecoveryReapplyConfirmationError,
} from "./recovery-reapply";
import type { PurgeMarkerSnapshot } from "./owner-purge";

const userId = asUserId("11111111-1111-7111-8111-111111111111");
const marker: PurgeMarkerSnapshot = {
  backupRetentionUntil: null,
  dataEpoch: 2,
  purgedAt: new Date("2026-08-16T12:00:00.000Z"),
  receipts: [],
  status: "retention_pending",
  writtenAt: new Date("2026-08-16T12:00:00.000Z"),
};

describe("marker reapply", () => {
  it("requires explicit confirmation and then reopens at the marker epoch", async () => {
    let state: "active" | "deleting" = "active";
    let businessEpoch = 1;
    const gate = createRecoveryGate({
      businessStateRepository: {
        findRecoveryBusinessState: async () => ({
          dataEpoch: businessEpoch,
          status: state,
        }),
      },
      markerRepository: { findLatestMarker: async () => marker },
    });
    let reapplied = false;
    const service = createRecoveryReapplyService({
      clock: () => new Date("2026-08-16T12:00:00.000Z"),
      gate,
      markerRepository: { findLatestMarker: async () => marker },
      repository: {
        reapplyMarker: async (input) => {
          expect(input.dataEpoch).toBe(2);
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
});
