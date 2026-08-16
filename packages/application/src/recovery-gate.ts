import type { UserId } from "@sayhear/domain";

import type { PurgeMarkerRepository, PurgeMarkerSnapshot } from "./owner-purge";

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
  businessDataEpoch: number | null;
  businessStatus: RecoveryBusinessState["status"] | null;
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
  state: RecoveryBusinessState | null,
  marker: PurgeMarkerSnapshot | null,
): RecoveryGateResult {
  return {
    businessDataEpoch: state?.dataEpoch ?? null,
    businessStatus: state?.status ?? null,
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
        return resultFor("unavailable", null, null);
      }

      if (state === null) {
        return resultFor("unavailable", state, marker);
      }
      if (marker === null) {
        // A clean first-generation database has no purge history. Any
        // non-active state or advanced epoch without its external marker is
        // an inconsistent restored database and must remain closed.
        return resultFor(
          state.status === "active" && state.dataEpoch === 1
            ? "open"
            : "needs_attention",
          state,
          marker,
        );
      }
      if (state.dataEpoch < marker.dataEpoch) {
        return resultFor("reapply_required", state, marker);
      }
      if (state.dataEpoch > marker.dataEpoch) {
        return resultFor("needs_attention", state, marker);
      }
      if (state.status !== "active") {
        return resultFor("needs_attention", state, marker);
      }
      return resultFor("open", state, marker);
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
