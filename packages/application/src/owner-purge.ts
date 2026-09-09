import type { UserId } from "@sayhear/domain";

import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
} from "./purge-surface-registry";

/**
 * Operator-only Internal Owner Full Purge across the closed 1A.3b surface
 * registry (Issue #194, ADR-0131, architecture 20). The application owns
 * the state-machine port and version fences; PostgreSQL owns the registered
 * clear and independent verification adapters.
 */

// ---- Purge order state machine (1A.2 subset, architecture 20.2) -----------

export type OwnerPurgeOrderStatus =
  | "requested"
  | "access_revoked"
  | "propagating"
  | "verifying"
  | "active_system_deleted"
  | "retention_pending"
  | "needs_attention";

export type OwnerPurgeOrder = Readonly<{
  ownerPurgeOrderId: string;
  userId: UserId;
  fromDataEpoch: number;
  dataEpoch: number;
  status: OwnerPurgeOrderStatus;
  policyVersion: string;
  purgeSurfaceRegistryVersion: string;
  externalIntegrationManifestVersion: string;
  workflowSubjectManifestVersion: string;
  requestedAt: Date;
  accessRevokedAt: Date | null;
  propagatingAt: Date | null;
  verifyingAt: Date | null;
  activeSystemDeletedAt: Date | null;
  retentionPendingAt: Date | null;
  needsAttentionAt: Date | null;
  needsAttentionReason: string | null;
  backupRetentionUntil: Date | null;
}>;

export type OwnerPurgeReceipt = Readonly<{
  destination: string;
  destinationDisposition:
    | "verified_deleted"
    | "retention_pending"
    | "policy_expired"
    | "not_applicable"
    | "unknown";
  providerDisposition:
    | "retention_pending"
    | "verified_deleted"
    | "policy_expired"
    | "not_applicable"
    | "unknown"
    | null;
  providerRetentionUntil: Date | null;
  backupRetentionUntil: Date | null;
  recordedAt: Date;
}>;

export type PurgeMarkerReceipt = Readonly<{
  destination: string;
  destinationDisposition: string;
  providerRetentionUntil: Date | null;
}>;

export type PurgeMarkerSnapshot = Readonly<{
  dataEpoch: number;
  status: "active_system_deleted" | "retention_pending";
  purgedAt: Date;
  backupRetentionUntil: Date | null;
  receipts: readonly PurgeMarkerReceipt[];
  writtenAt: Date;
}>;

// ---- Repository port (implemented by the data layer) -----------------------

export type OwnerPurgeClearResult = Readonly<{
  providerRoles: readonly string[];
  backupRetentionUntil: Date | null;
}>;

export type OwnerPurgeRepository = Readonly<{
  /**
   * The opening transaction (architecture 20.3, steps 1-4): lock the owner,
   * mark `deleting`, advance `data_epoch`, revoke undispatched Provider egress
   * authorization, delete active Web sessions (cascading diagnostic grants),
   * and create one idempotent deletion command + outbox event — all atomically,
   * then normal reads/writes are blocked by the existing fences.
   *
   * Idempotent: a duplicate start while an order is in flight returns that
   * order (`created: false`) without a second destructive effect.
   */
  startOrder(input: {
    userId: UserId;
    confirmation: "PURGE";
    policyVersion: string;
    purgeSurfaceRegistryVersion?: string;
    externalIntegrationManifestVersion?: string;
    workflowSubjectManifestVersion?: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "started"; order: OwnerPurgeOrder; created: boolean }>
    | Readonly<{ outcome: "owner_not_active" }>
    | Readonly<{ outcome: "inconsistent_owner_state" }>
  >;
  findOrder(input: {
    ownerPurgeOrderId: string;
  }): Promise<OwnerPurgeOrder | null>;
  findLatestOrder(input: { userId: UserId }): Promise<OwnerPurgeOrder | null>;
  listReceipts(input: {
    ownerPurgeOrderId: string;
  }): Promise<readonly OwnerPurgeReceipt[]>;
  /**
   * Record that one propagation attempt began (recovery-scan retry budget).
   */
  markAttemptStarted(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<void>;
  /**
   * CAS transition to `access_revoked` and, in the same transaction,
   * batch-cancel every pending/leased outbox event and created/dispatched
   * workflow command owned by this owner's Daily Sessions (terminal
   * `cancelled_reason='owner_purged'`, leases cleared) — excluding the purge
   * order's own driving command. Returns the workflow receipt ids of
   * dispatched runs for best-effort cancellation.
   */
  transitionToAccessRevoked(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<
    Readonly<{ workflowReceiptIds: readonly string[] }> | Readonly<{ outcome: "not_applicable" }>
  >;
  /**
   * CAS transition to `propagating` and clear every owner-scoped surface in
   * one purge-pass transaction: tombstone conversation_event_revisions content,
   * hard-DELETE the 1A.2 tables, and write the business-database/provider
   * receipts. Provider roles and the backup retention horizon are captured
   * BEFORE the deletes so receipts reflect what actually received data.
   */
  transitionToPropagatingAndClear(input: {
    ownerPurgeOrderId: string;
    providerRetentionUntil?: Date;
    effectivePurgeAt?: Date;
    backupRetentionUntil?: Date | null;
    providerReceipts?: readonly PurgeMarkerReceipt[];
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "cleared" } & OwnerPurgeClearResult>
    | Readonly<{ outcome: "not_applicable" }>
  >;
  /**
   * CAS transition to `verifying` and assert, in the same transaction, that
   * every owner-scoped surface is empty, every surviving revision tombstone is
   * purged, and no executable command remains. Throws PurgeVerificationError
   * on any violation (the transaction rolls back).
   */
  transitionToVerifying(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<Readonly<{ outcome: "verified" }> | Readonly<{ outcome: "not_applicable" }>>;
  /**
   * CAS transition to `active_system_deleted` and record the
   * business-database and purge-marker-store receipts (content-free).
   */
  transitionToActiveSystemDeleted(input: {
    ownerPurgeOrderId: string;
    backupRetentionUntil: Date | null;
    effectivePurgeAt?: Date;
    now: Date;
  }): Promise<Readonly<{ outcome: "active_system_deleted" }> | Readonly<{ outcome: "not_applicable" }>>;
  /**
   * CAS transition to `retention_pending`, revive the owner
   * (`status='active'` at the advanced epoch — old data cannot resurrect), and
   * remove the purge order's own terminal workflow command/outbox event.
   */
  finalizeRetentionPending(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<Readonly<{ outcome: "retention_pending" }> | Readonly<{ outcome: "not_applicable" }>>;
  markNeedsAttention(input: {
    ownerPurgeOrderId: string;
    reason: string;
    now: Date;
    expectedStatus?: OwnerPurgeOrderStatus;
  }): Promise<void>;
  /**
   * Orders not yet at `retention_pending` whose last attempt is older than the
   * retry horizon (or that are parked in `needs_attention`) — the recovery
   * scan's auto-retry worklist.
   */
  listRetryableOrders(input: {
    now: Date;
    staleAfterMs: number;
    limit: number;
  }): Promise<readonly OwnerPurgeOrder[]>;
  /** Sweep only registry-declared, read-deadline-bound owner metadata. */
  sweepExpiredMetadata?(input: {
    now: Date;
  }): Promise<Readonly<{ deleted: number }>>;
  /**
   * Recovery-only marker reapply. The adapter advances the restored database
   * directly to the marker epoch and reuses the purge verification walker;
   * it never creates a later epoch or writes the external marker.
   */
  reapplyMarker?(input: {
    userId: UserId;
    dataEpoch: number;
    purgedAt: Date;
    backupRetentionUntil: Date | null;
    receipts: readonly PurgeMarkerReceipt[];
    now: Date;
  }): Promise<Readonly<{ outcome: "reapplied" }>>;
}>;

export type PurgeMarkerRepository = Readonly<{
  /**
   * Atomic per-owner high-water update. Equal epochs are immutable no-ops and
   * lower epochs cannot replace a newer marker.
   */
  writeMarker(input: {
    userId: UserId;
    dataEpoch: number;
    purgedAt: Date;
    backupRetentionUntil: Date | null;
    receipts: readonly PurgeMarkerReceipt[];
  }): Promise<void>;
  /** Recovery always reads the latest marker; it never guesses an epoch. */
  findLatestMarker(input: { userId: UserId }): Promise<PurgeMarkerSnapshot | null>;
  /** Compatibility helper for existing purge-drill callers; recovery must use latest. */
  findMarker?(input: {
    userId: UserId;
    dataEpoch: number;
  }): Promise<PurgeMarkerSnapshot | null>;
}>;

// ---- Errors ----------------------------------------------------------------

export class OwnerPurgeConfirmationError extends Error {
  public constructor() {
    super("Full Purge requires the explicit confirmation field {\"confirm\":\"PURGE\"}.");
    this.name = "OwnerPurgeConfirmationError";
  }
}

export class OwnerPurgeOwnerStateError extends Error {
  public constructor(
    public readonly reason: "owner_not_active" | "inconsistent_owner_state",
  ) {
    super("The Internal Owner is not in a state that can start Full Purge.");
    this.name = "OwnerPurgeOwnerStateError";
  }
}

export class OwnerPurgeOrderNotFoundError extends Error {
  public constructor() {
    super("The requested purge order does not exist.");
    this.name = "OwnerPurgeOrderNotFoundError";
  }
}

export class PurgeVerificationError extends Error {
  public constructor(public readonly violation: string) {
    super(`Full Purge verification failed: ${violation}`);
    this.name = "PurgeVerificationError";
  }
}

export class OwnerPurgePropagationError extends Error {
  public constructor(
    public readonly reason: string,
    public readonly status: OwnerPurgeOrderStatus,
  ) {
    super(`Full Purge propagation failed: ${reason}`);
    this.name = "OwnerPurgePropagationError";
  }
}

function sanitizePurgeReason(error: unknown): string {
  if (error instanceof PurgeVerificationError) {
    return `verification_failed:${error.violation}`;
  }
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("timeout") || message.includes("timed out")) {
      return "database_timeout";
    }
    if (message.includes("econn") || message.includes("network")) {
      return "network_error";
    }
  }
  return "unknown_error";
}

function isMarkerReconciliationRequired(order: OwnerPurgeOrder): boolean {
  const reason = order.needsAttentionReason ?? "";
  return (
    order.status === "needs_attention" &&
    (reason === "purge_marker_missing" ||
      reason === "purge_marker_epoch_mismatch" ||
      reason === "purge_marker_invalid" ||
      reason === "purge_marker_receipts_mismatch" ||
      reason.startsWith("verification_failed:purge_marker_"))
  );
}

export function isValidPurgeMarkerSnapshot(
  marker: PurgeMarkerSnapshot,
): boolean {
  const seen = new Set<string>();
  const businessReceipts = marker.receipts.filter(
    (receipt) => receipt.destination === "business_database",
  );
  if (
    !["active_system_deleted", "retention_pending"].includes(marker.status) ||
    Number.isNaN(marker.purgedAt.getTime()) ||
    Number.isNaN(marker.writtenAt.getTime())
  ) {
    return false;
  }
  for (const receipt of marker.receipts) {
    if (seen.has(receipt.destination)) {
      return false;
    }
    seen.add(receipt.destination);
    if (receipt.destination === "business_database") {
      if (
        !["verified_deleted", "not_applicable"].includes(
          receipt.destinationDisposition,
        ) ||
        receipt.providerRetentionUntil !== null
      ) {
        return false;
      }
      continue;
    }
    if (
      !receipt.destination.startsWith("provider:") ||
      receipt.destination.length <= "provider:".length ||
      ![
        "retention_pending",
        "verified_deleted",
        "policy_expired",
        "not_applicable",
      ].includes(receipt.destinationDisposition) ||
      (["retention_pending", "policy_expired"].includes(
        receipt.destinationDisposition,
      ) &&
        receipt.providerRetentionUntil === null)
    ) {
      return false;
    }
  }
  if (businessReceipts.length !== 1 || !seen.has("business_database")) {
    return false;
  }
  if (
    marker.dataEpoch <= 0 ||
    !Number.isInteger(marker.dataEpoch) ||
    (marker.backupRetentionUntil !== null &&
      Number.isNaN(marker.backupRetentionUntil.getTime())) ||
    marker.writtenAt.getTime() < marker.purgedAt.getTime()
  ) {
    return false;
  }
  return marker.receipts.every(
    (receipt) =>
      receipt.providerRetentionUntil === null ||
      !Number.isNaN(receipt.providerRetentionUntil.getTime()),
  );
}

export function markerReceiptsMatchLocalReceipts(
  marker: PurgeMarkerSnapshot,
  receipts: readonly OwnerPurgeReceipt[],
): boolean {
  const toKey = (receipt: Readonly<{
    destination: string;
    destinationDisposition: string;
    providerDisposition?: string | null;
    providerRetentionUntil: Date | null;
  }>): string | null => {
    const isProvider = receipt.destination.startsWith("provider:");
    if (isProvider) {
      const providerDisposition = receipt.providerDisposition;
      if (
        (providerDisposition !== undefined && providerDisposition === null) ||
        (providerDisposition !== undefined && providerDisposition === "unknown") ||
        (providerDisposition !== undefined &&
          providerDisposition !== receipt.destinationDisposition) ||
        (providerDisposition === undefined &&
          receipt.destinationDisposition === "unknown")
      ) {
        return null;
      }
    } else if (receipt.providerDisposition !== undefined && receipt.providerDisposition !== null) {
      return null;
    }
    return [
      receipt.destination,
      receipt.destinationDisposition,
      isProvider ? receipt.destinationDisposition : "",
      receipt.providerRetentionUntil?.getTime() ?? "",
    ].join("|");
  };
  const localBusinessReceipt = receipts.find(
    (receipt) => receipt.destination === "business_database",
  );
  if (
    localBusinessReceipt &&
    localBusinessReceipt.backupRetentionUntil?.getTime() !==
      marker.backupRetentionUntil?.getTime()
  ) {
    return false;
  }
  const local = receipts
    .filter((receipt) => receipt.destination !== "purge_marker_store")
    .map(toKey);
  const external = marker.receipts.map(toKey);
  if (local.some((receipt) => receipt === null) || external.some((receipt) => receipt === null)) {
    return false;
  }
  const sortedLocal = local.filter((receipt): receipt is string => receipt !== null).sort();
  const sortedExternal = external.filter((receipt): receipt is string => receipt !== null).sort();
  return (
    sortedLocal.length === sortedExternal.length &&
    sortedLocal.every((receipt, index) => receipt === sortedExternal[index])
  );
}

// ---- Service ----------------------------------------------------------------

export const OWNER_FULL_PURGE_POLICY_VERSION = "owner-full-purge:v1";

export type OwnerFullPurgeService = Readonly<{
  /** Operator idempotent start: create or return the in-flight order. */
  start(input: {
    userId: UserId;
    confirmation: string;
  }): Promise<Readonly<{ order: OwnerPurgeOrder; created: boolean; receipts: readonly OwnerPurgeReceipt[] }>>;
  /** Content-free purge state inspection (no private content). */
  inspect(input: {
    userId: UserId;
  }): Promise<Readonly<{ order: OwnerPurgeOrder | null; receipts: readonly OwnerPurgeReceipt[] }>>;
  /**
   * Idempotent state-machine walker. Every step is a compare-and-set
   * transaction, so duplicate starts, Workflow retries, and recovery-scan
   * reconciliation converge without duplicate destructive effects or illegal
   * state regression.
   */
  propagate(input: {
    ownerPurgeOrderId: string;
  }): Promise<Readonly<{ status: OwnerPurgeOrderStatus }>>;
  /**
   * The durable Workflow entrypoint's view: propagate the owner's latest
   * order, fenced to the command's frozen epoch — a stale Workflow run from a
   * previous epoch must not drive a newer order.
   */
  propagateForOwner(input: {
    userId: UserId;
    expectedDataEpoch: number;
    purgeSurfaceRegistryVersion?: string;
    externalIntegrationManifestVersion?: string;
    workflowSubjectManifestVersion?: string;
  }): Promise<
    | Readonly<{ status: OwnerPurgeOrderStatus }>
    | Readonly<{ outcome: "no_order" }>
    | Readonly<{ outcome: "epoch_mismatch" }>
    | Readonly<{ outcome: "registry_mismatch" }>
  >;
  /** Recovery-scan entrypoint: auto-retry stuck or needs_attention orders. */
  scanPendingOrders(input: {
    now: Date;
  }): Promise<Readonly<{ retried: number; remaining: number }>>;
}>;

export function createOwnerFullPurgeService(dependencies: {
  clock: () => Date;
  repository: OwnerPurgeRepository;
  markerRepository: PurgeMarkerRepository;
  /** Documented Provider retention horizon in days (receipts only — no
   * Provider deletion API calls exist in 1A.2; reconciliation is External MVP
   * Gate scope, ADR-0022). */
  providerRetentionDays: number;
  /**
   * Best-effort durable-workflow cancellation. Vercel Workflows v4.8 exposes
   * no public cancel API, so the default is a no-op: correctness relies on the
   * epoch fences, revoked egress authorization, and cancelled commands —
   * never on this hook (issue #27 settled decisions).
   */
  cancelWorkflows?: (workflowReceiptIds: readonly string[]) => Promise<void>;
  /** How long after the last attempt a non-terminal order becomes retryable. */
  staleRetryMs?: number;
  scanLimit?: number;
}): OwnerFullPurgeService {
  if (
    !Number.isInteger(dependencies.providerRetentionDays) ||
    dependencies.providerRetentionDays <= 0
  ) {
    throw new Error("providerRetentionDays must be a positive integer.");
  }
  const staleRetryMs = dependencies.staleRetryMs ?? 60_000;
  const scanLimit = dependencies.scanLimit ?? 10;

  return {
    async start(input) {
      if (input.confirmation !== "PURGE") {
        throw new OwnerPurgeConfirmationError();
      }
      const now = dependencies.clock();
      const started = await dependencies.repository.startOrder({
        confirmation: "PURGE",
        now,
        policyVersion: OWNER_FULL_PURGE_POLICY_VERSION,
        externalIntegrationManifestVersion:
          PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
        purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_VERSION,
        workflowSubjectManifestVersion:
          PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
        userId: input.userId,
      });
      if (started.outcome !== "started") {
        throw new OwnerPurgeOwnerStateError(started.outcome);
      }
      // The endpoint triggers one best-effort propagation pass inline; the
      // recovery scan and dispatcher retries converge the rest. A propagation
      // failure parks the order in needs_attention — never a second
      // destructive effect.
      try {
        await this.propagate({ ownerPurgeOrderId: started.order.ownerPurgeOrderId });
      } catch {
        // Swallowed deliberately: the order is durable and the scan retries.
      }
      const order =
        (await dependencies.repository.findOrder({
          ownerPurgeOrderId: started.order.ownerPurgeOrderId,
        })) ?? started.order;
      return {
        created: started.created,
        order,
        receipts: await dependencies.repository.listReceipts({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        }),
      };
    },

    async inspect(input) {
      const order = await dependencies.repository.findLatestOrder({
        userId: input.userId,
      });
      if (order === null) {
        return { order: null, receipts: [] };
      }
      return {
        order,
        receipts: await dependencies.repository.listReceipts({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        }),
      };
    },

    async propagate(input) {
      const order = await dependencies.repository.findOrder({
        ownerPurgeOrderId: input.ownerPurgeOrderId,
      });
      if (order === null) {
        throw new OwnerPurgeOrderNotFoundError();
      }
      if (order.status === "retention_pending") {
        return { status: order.status };
      }
      if (
        order.status === "active_system_deleted" ||
        isMarkerReconciliationRequired(order)
      ) {
        // An active-system-deleted order is only finalized by the recovery
        // scanner after it validates the external marker and local receipts.
        // Marker-related attention states are operator-only for the same
        // reason; a durable Workflow retry must not mint a replacement marker
        // or a fresh retention window.
        return { status: order.status };
      }
      await dependencies.repository.markAttemptStarted({
        ownerPurgeOrderId: order.ownerPurgeOrderId,
        now: dependencies.clock(),
      });
      let expectedStatusForErrors: OwnerPurgeOrderStatus = order.status;
      try {
        // Step 1 — access_revoked: cancel owner-scoped commands atomically.
        const revoke =
          await dependencies.repository.transitionToAccessRevoked({
            now: dependencies.clock(),
            ownerPurgeOrderId: order.ownerPurgeOrderId,
          });
        if ("workflowReceiptIds" in revoke) {
          try {
            await dependencies.cancelWorkflows?.(revoke.workflowReceiptIds);
          } catch {
            // Best-effort by design; fences own correctness.
          }
        }

        // Step 2 — propagating: one purge-pass transaction clears every
        // owner-scoped surface and captures provider roles for receipts.
        // Once the clear transaction commits, propagatingAt is the durable
        // effective purge time. Every retry must reuse it so metadata and
        // provider retention windows cannot be extended by a new attempt.
        const requestedEffectivePurgeAt =
          order.propagatingAt ?? dependencies.clock();
        const providerRetentionUntil =
          order.propagatingAt === null
            ? new Date(
                requestedEffectivePurgeAt.getTime() +
                  dependencies.providerRetentionDays * 24 * 60 * 60 * 1_000,
              )
            : undefined;
        const clearResult =
          await dependencies.repository.transitionToPropagatingAndClear({
            now: dependencies.clock(),
            ownerPurgeOrderId: order.ownerPurgeOrderId,
            effectivePurgeAt: requestedEffectivePurgeAt,
            ...(providerRetentionUntil !== undefined
              ? { providerRetentionUntil }
              : {}),
          });

        // Another propagation attempt may have won the row lock and moved the
        // order beyond the clear step. Never let this invocation's original
        // snapshot mint a marker or retention window for that newer state.
        const currentOrder = await dependencies.repository.findOrder({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });
        if (currentOrder === null || currentOrder.dataEpoch !== order.dataEpoch) {
          throw new PurgeVerificationError("purge_order_epoch_changed");
        }
        expectedStatusForErrors = currentOrder.status;
        if (
          currentOrder.status === "retention_pending" ||
          currentOrder.status === "active_system_deleted" ||
          currentOrder.status === "needs_attention"
        ) {
          return { status: currentOrder.status };
        }
        if (!(currentOrder.status === "propagating" || currentOrder.status === "verifying")) {
          throw new PurgeVerificationError(
            `purge_order_unexpected_status:${currentOrder.status}`,
          );
        }
        const effectivePurgeAt =
          currentOrder.propagatingAt ?? requestedEffectivePurgeAt;

        // Step 3 — purge marker, written to the separate marker database
        // BEFORE the business side claims active_system_deleted. Idempotent,
        // so a crash between marker write and state transition converges.
        // When the clear step already committed on a previous attempt, the
        // provider receipts are read back from the durable receipts table so
        // a retry writes the identical marker content.
        const durableReceipts = await dependencies.repository.listReceipts({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });
        const providerMarkerReceipts = durableReceipts
          .filter((receipt) => receipt.destination.startsWith("provider:"))
          .map((receipt) => ({
            destination: receipt.destination,
            destinationDisposition: receipt.destinationDisposition,
            providerRetentionUntil: receipt.providerRetentionUntil,
          }));
        const backupRetentionUntilForMarker =
          currentOrder.backupRetentionUntil ??
          (clearResult.outcome === "cleared"
            ? clearResult.backupRetentionUntil
            : null);
        const markerReceipts = [
          {
            destination: "business_database",
            destinationDisposition: "verified_deleted",
            providerRetentionUntil: null as Date | null,
          },
          ...providerMarkerReceipts,
        ];
        if (currentOrder.status === "propagating") {
          await dependencies.markerRepository.writeMarker({
            backupRetentionUntil: backupRetentionUntilForMarker,
            dataEpoch: currentOrder.dataEpoch,
            purgedAt: effectivePurgeAt,
            receipts: markerReceipts,
            userId: currentOrder.userId,
          });
        }
        const marker = await dependencies.markerRepository.findLatestMarker({
          userId: currentOrder.userId,
        });
        if (
          marker === null ||
          marker.dataEpoch !== currentOrder.dataEpoch ||
          !isValidPurgeMarkerSnapshot(marker)
        ) {
          throw new PurgeVerificationError(
            marker === null
              ? "purge_marker_missing"
              : marker.dataEpoch !== currentOrder.dataEpoch
                ? "purge_marker_epoch_mismatch"
                : "purge_marker_invalid",
          );
        }

        // The marker is written in a separate database. Compare it with the
        // business receipts before the local state can claim deletion. The
        // business receipt is inserted by the next CAS transition, so include
        // its deterministic pre-commit envelope for this comparison.
        const markerComparisonReceipts = durableReceipts.some(
          (receipt) => receipt.destination === "business_database",
        )
          ? durableReceipts
          : [
              ...durableReceipts,
              {
                destination: "business_database",
                destinationDisposition: "verified_deleted" as const,
                providerDisposition: null,
                providerRetentionUntil: null,
                backupRetentionUntil: backupRetentionUntilForMarker,
                recordedAt: effectivePurgeAt,
              },
            ];
        if (!markerReceiptsMatchLocalReceipts(marker, markerComparisonReceipts)) {
          throw new PurgeVerificationError("purge_marker_receipts_mismatch");
        }

        // Step 4 — verifying: assert no content and no executable work remain.
        await dependencies.repository.transitionToVerifying({
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });

        // Step 5 — active_system_deleted + terminal receipts.
        await dependencies.repository.transitionToActiveSystemDeleted({
          backupRetentionUntil: backupRetentionUntilForMarker,
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
          effectivePurgeAt,
        });

        // Step 6 — retention_pending + owner revival.
        const finalized = await dependencies.repository.finalizeRetentionPending({
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });
        const finalOrder = await dependencies.repository.findOrder({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });
        return {
          status: finalized.outcome === "not_applicable" && finalOrder
            ? finalOrder.status
            : "retention_pending",
        };
      } catch (error) {
        const reason = sanitizePurgeReason(error);
        await dependencies.repository.markNeedsAttention({
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
          reason,
          expectedStatus: expectedStatusForErrors,
        });
        const parked = await dependencies.repository.findOrder({
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });
        throw new OwnerPurgePropagationError(
          reason,
          parked?.status ?? "needs_attention",
        );
      }
    },

    async propagateForOwner(input) {
      const order = await dependencies.repository.findLatestOrder({
        userId: input.userId,
      });
      if (order === null) {
        return { outcome: "no_order" };
      }
      if (order.dataEpoch !== input.expectedDataEpoch) {
        return { outcome: "epoch_mismatch" };
      }
      if (
        input.purgeSurfaceRegistryVersion !== undefined &&
        order.purgeSurfaceRegistryVersion !== input.purgeSurfaceRegistryVersion
      ) {
        return { outcome: "registry_mismatch" };
      }
      if (
        input.externalIntegrationManifestVersion !== undefined &&
        order.externalIntegrationManifestVersion !==
          input.externalIntegrationManifestVersion
      ) {
        return { outcome: "registry_mismatch" };
      }
      if (
        input.workflowSubjectManifestVersion !== undefined &&
        order.workflowSubjectManifestVersion !== input.workflowSubjectManifestVersion
      ) {
        return { outcome: "registry_mismatch" };
      }
      return await this.propagate({
        ownerPurgeOrderId: order.ownerPurgeOrderId,
      });
    },

    async scanPendingOrders(input) {
      await dependencies.repository.sweepExpiredMetadata?.({ now: input.now });
      const stale = await dependencies.repository.listRetryableOrders({
        limit: scanLimit,
        now: input.now,
        staleAfterMs: staleRetryMs,
      });
      let remaining = 0;
      for (const order of stale) {
        const markerReconciliationRequired =
          isMarkerReconciliationRequired(order);
        if (order.status === "active_system_deleted" || markerReconciliationRequired) {
          let marker: PurgeMarkerSnapshot | null = null;
          let localReceipts: readonly OwnerPurgeReceipt[] | null = null;
          try {
            marker = await dependencies.markerRepository.findLatestMarker({
              userId: order.userId,
            });
            if (order.status === "active_system_deleted" && marker !== null) {
              localReceipts = await dependencies.repository.listReceipts({
                ownerPurgeOrderId: order.ownerPurgeOrderId,
              });
            }
          } catch {
            // The order remains parked until the external recovery authority
            // is reachable and verified.
          }
          if (
            marker === null ||
            marker.dataEpoch !== order.dataEpoch ||
            !isValidPurgeMarkerSnapshot(marker) ||
            (order.status === "active_system_deleted" &&
              (localReceipts === null ||
                !markerReceiptsMatchLocalReceipts(marker, localReceipts)))
          ) {
            await dependencies.repository.markNeedsAttention({
              now: input.now,
              ownerPurgeOrderId: order.ownerPurgeOrderId,
              reason:
                marker === null
                  ? "purge_marker_missing"
                  : marker.dataEpoch !== order.dataEpoch
                    ? "purge_marker_epoch_mismatch"
                    : "purge_marker_invalid",
              expectedStatus: order.status,
            });
            remaining += 1;
            continue;
          }
          if (markerReconciliationRequired) {
            // Marker-related attention states are operator-only. A marker that
            // appears later is not enough to prove the local order and marker
            // are a consistent pair, so never mint a replacement marker or
            // revive the owner from this automatic path.
            remaining += 1;
            continue;
          }
          // An already verified local purge only needs its marker-backed
          // retention finalization. Re-entering the normal propagation path
          // would write a replacement marker and could silently mint a new
          // retention window.
          if (order.status === "active_system_deleted") {
            try {
              await dependencies.repository.finalizeRetentionPending({
                now: input.now,
                ownerPurgeOrderId: order.ownerPurgeOrderId,
              });
            } catch {
              remaining += 1;
            }
            continue;
          }
        }
        try {
          await this.propagate({ ownerPurgeOrderId: order.ownerPurgeOrderId });
        } catch {
          remaining += 1;
        }
      }
      return { remaining, retried: stale.length };
    },
  };
}
