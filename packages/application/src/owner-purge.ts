import type { UserId } from "@sayhear/domain";

/**
 * Operator-only Internal Owner Full Purge across the active 1A.2 data
 * surface (issue #27, ADR-0022, architecture 20).
 *
 * Conversation Action surfaces are intentionally NOT cleared here as tables:
 * the 1A.2 schema shipped only frozen version columns on generation_commands
 * plus the in-memory Action Catalog (issue #26) — no Action envelope /
 * payload / execution / receipt tables exist yet, so that acceptance
 * criterion closes as N/A. The Catalog itself contains no deletion
 * operations, which is why natural-language Conversation requests can never
 * reach this purge.
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
    | "not_applicable"
    | "unknown";
  providerDisposition: "retention_pending" | "unknown" | null;
  providerRetentionUntil: Date | null;
  backupRetentionUntil: Date | null;
  recordedAt: Date;
}>;

export type PurgeMarkerSnapshot = Readonly<{
  dataEpoch: number;
  status: "active_system_deleted" | "retention_pending";
  purgedAt: Date;
  backupRetentionUntil: Date | null;
  receipts: readonly Readonly<{
    destination: string;
    destinationDisposition: string;
    providerRetentionUntil: Date | null;
  }>[];
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
    providerRetentionUntil: Date;
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
}>;

export type PurgeMarkerRepository = Readonly<{
  /** Idempotent: ON CONFLICT (user_id, data_epoch) DO NOTHING. */
  writeMarker(input: {
    userId: UserId;
    dataEpoch: number;
    purgedAt: Date;
    backupRetentionUntil: Date | null;
    receipts: readonly Readonly<{
      destination: string;
      destinationDisposition: string;
      providerRetentionUntil: Date | null;
    }>[];
  }): Promise<void>;
  findMarker(input: {
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
  }): Promise<
    | Readonly<{ status: OwnerPurgeOrderStatus }>
    | Readonly<{ outcome: "no_order" }>
    | Readonly<{ outcome: "epoch_mismatch" }>
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
      await dependencies.repository.markAttemptStarted({
        ownerPurgeOrderId: order.ownerPurgeOrderId,
        now: dependencies.clock(),
      });
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
        const providerRetentionUntil = new Date(
          dependencies.clock().getTime() +
            dependencies.providerRetentionDays * 24 * 60 * 60 * 1_000,
        );
        const clearResult =
          await dependencies.repository.transitionToPropagatingAndClear({
            now: dependencies.clock(),
            ownerPurgeOrderId: order.ownerPurgeOrderId,
            providerRetentionUntil,
          });

        // Step 3 — purge marker, written to the separate marker database
        // BEFORE the business side claims active_system_deleted. Idempotent,
        // so a crash between marker write and state transition converges.
        // When the clear step already committed on a previous attempt, the
        // provider receipts are read back from the durable receipts table so
        // a retry writes the identical marker content.
        const providerMarkerReceipts =
          clearResult.outcome === "not_applicable"
            ? (
                await dependencies.repository.listReceipts({
                  ownerPurgeOrderId: order.ownerPurgeOrderId,
                })
              )
                .filter((receipt) => receipt.destination.startsWith("provider:"))
                .map((receipt) => ({
                  destination: receipt.destination,
                  destinationDisposition: receipt.destinationDisposition,
                  providerRetentionUntil: receipt.providerRetentionUntil,
                }))
            : clearResult.providerRoles.map((role) => ({
                destination: `provider:${role}` as const,
                destinationDisposition: "retention_pending" as const,
                providerRetentionUntil,
              }));
        const markerReceipts = [
          {
            destination: "business_database",
            destinationDisposition: "verified_deleted",
            providerRetentionUntil: null as Date | null,
          },
          ...providerMarkerReceipts,
        ];
        await dependencies.markerRepository.writeMarker({
          backupRetentionUntil:
            clearResult.outcome === "not_applicable"
              ? order.backupRetentionUntil
              : clearResult.backupRetentionUntil,
          dataEpoch: order.dataEpoch,
          purgedAt: dependencies.clock(),
          receipts: markerReceipts,
          userId: order.userId,
        });
        const marker = await dependencies.markerRepository.findMarker({
          dataEpoch: order.dataEpoch,
          userId: order.userId,
        });
        if (marker === null) {
          throw new PurgeVerificationError("purge_marker_missing");
        }

        // Step 4 — verifying: assert no content and no executable work remain.
        await dependencies.repository.transitionToVerifying({
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
        });

        // Step 5 — active_system_deleted + terminal receipts.
        await dependencies.repository.transitionToActiveSystemDeleted({
          backupRetentionUntil:
            clearResult.outcome === "not_applicable"
              ? order.backupRetentionUntil
              : clearResult.backupRetentionUntil,
          now: dependencies.clock(),
          ownerPurgeOrderId: order.ownerPurgeOrderId,
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
      return await this.propagate({
        ownerPurgeOrderId: order.ownerPurgeOrderId,
      });
    },

    async scanPendingOrders(input) {
      const stale = await dependencies.repository.listRetryableOrders({
        limit: scanLimit,
        now: input.now,
        staleAfterMs: staleRetryMs,
      });
      let remaining = 0;
      for (const order of stale) {
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
