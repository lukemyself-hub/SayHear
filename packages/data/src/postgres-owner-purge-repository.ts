import type {
  OwnerPurgeClearResult,
  OwnerPurgeOrder,
  OwnerPurgeOrderStatus,
  OwnerPurgeReceipt,
  OwnerPurgeRepository,
} from "@sayhear/application";
import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
  assertPurgeSurfaceRegistry,
  PURGE_SURFACE_REGISTRY_SNAPSHOT,
  PURGE_SURFACE_REGISTRY_LEGACY_VERSION,
  PURGE_SURFACE_REGISTRY_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION,
  PurgeSurfaceRegistryError,
  PurgeVerificationError,
  type PurgeSurfaceEntry,
} from "@sayhear/application";
import { asUserId, type UserId } from "@sayhear/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  assertPurgeSurfaceAdapterCoverage,
  assertPurgeSurfaceDatabaseInventory,
  clearPurgeSurface,
  clearPurgeSurfaceIntegration,
  OWNER_WORKFLOW_COMMAND_SCOPE,
  sweepExpiredPurgeSurface,
  verifyPurgeSurface,
  verifyPurgeSurfaceIntegration,
} from "./postgres-purge-surface-adapters";

type OrderRow = Readonly<{
  owner_purge_order_id: string;
  user_id: string;
  from_data_epoch: string;
  data_epoch: string;
  status: string;
  policy_version: string;
  purge_surface_registry_version: string;
  external_integration_manifest_version: string;
  workflow_subject_manifest_version: string;
  requested_at: Date;
  access_revoked_at: Date | null;
  propagating_at: Date | null;
  verifying_at: Date | null;
  active_system_deleted_at: Date | null;
  retention_pending_at: Date | null;
  needs_attention_at: Date | null;
  needs_attention_reason: string | null;
  backup_retention_until: Date | null;
}>;

type ReceiptRow = Readonly<{
  destination: string;
  destination_disposition: string;
  provider_disposition: string | null;
  provider_retention_until: Date | null;
  backup_retention_until: Date | null;
  recorded_at: Date;
}>;

function assertCurrentPurgeVersions(
  row: Pick<
    OrderRow,
    | "purge_surface_registry_version"
    | "external_integration_manifest_version"
    | "workflow_subject_manifest_version"
  >,
): void {
  if (row.purge_surface_registry_version !== PURGE_SURFACE_REGISTRY_VERSION) {
    throw new PurgeVerificationError("purge_surface_registry_version_mismatch");
  }
  if (
    row.external_integration_manifest_version !==
    PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION
  ) {
    throw new PurgeVerificationError(
      "external_integration_manifest_version_mismatch",
    );
  }
  if (
    row.workflow_subject_manifest_version !==
    PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION
  ) {
    throw new PurgeVerificationError(
      "workflow_subject_manifest_version_mismatch",
    );
  }
}

const LEGACY_PURGE_VERSIONS = {
  externalIntegrationManifestVersion:
    PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION,
  purgeSurfaceRegistryVersion: PURGE_SURFACE_REGISTRY_LEGACY_VERSION,
  workflowSubjectManifestVersion:
    PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION,
} as const;

function isCurrentPurgeVersions(
  row: Pick<
    OrderRow,
    | "purge_surface_registry_version"
    | "external_integration_manifest_version"
    | "workflow_subject_manifest_version"
  >,
): boolean {
  return (
    row.purge_surface_registry_version === PURGE_SURFACE_REGISTRY_VERSION &&
    row.external_integration_manifest_version ===
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION &&
    row.workflow_subject_manifest_version ===
      PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION
  );
}

function isLegacyPurgeVersions(
  row: Pick<
    OrderRow,
    | "purge_surface_registry_version"
    | "external_integration_manifest_version"
    | "workflow_subject_manifest_version"
  >,
): boolean {
  return (
    row.purge_surface_registry_version ===
      LEGACY_PURGE_VERSIONS.purgeSurfaceRegistryVersion &&
    row.external_integration_manifest_version ===
      LEGACY_PURGE_VERSIONS.externalIntegrationManifestVersion &&
    row.workflow_subject_manifest_version ===
      LEGACY_PURGE_VERSIONS.workflowSubjectManifestVersion
  );
}

function mapOrder(row: OrderRow): OwnerPurgeOrder {
  return {
    ownerPurgeOrderId: row.owner_purge_order_id,
    userId: asUserId(row.user_id),
    fromDataEpoch: Number(row.from_data_epoch),
    dataEpoch: Number(row.data_epoch),
    status: row.status as OwnerPurgeOrderStatus,
    policyVersion: row.policy_version,
    purgeSurfaceRegistryVersion: row.purge_surface_registry_version,
    externalIntegrationManifestVersion:
      row.external_integration_manifest_version,
    workflowSubjectManifestVersion: row.workflow_subject_manifest_version,
    requestedAt: row.requested_at,
    accessRevokedAt: row.access_revoked_at,
    propagatingAt: row.propagating_at,
    verifyingAt: row.verifying_at,
    activeSystemDeletedAt: row.active_system_deleted_at,
    retentionPendingAt: row.retention_pending_at,
    needsAttentionAt: row.needs_attention_at,
    needsAttentionReason: row.needs_attention_reason,
    backupRetentionUntil: row.backup_retention_until,
  };
}

function mapReceipt(row: ReceiptRow): OwnerPurgeReceipt {
  return {
    destination: row.destination,
    destinationDisposition: row.destination_disposition as OwnerPurgeReceipt["destinationDisposition"],
    providerDisposition: row.provider_disposition as OwnerPurgeReceipt["providerDisposition"],
    providerRetentionUntil: row.provider_retention_until,
    backupRetentionUntil: row.backup_retention_until,
    recordedAt: row.recorded_at,
  };
}

const ORDER_COLUMNS = `
  owner_purge_order_id, user_id, from_data_epoch::text, data_epoch::text,
  status, policy_version, purge_surface_registry_version, requested_at,
  external_integration_manifest_version,
  workflow_subject_manifest_version,
  access_revoked_at, propagating_at,
  verifying_at, active_system_deleted_at, retention_pending_at,
  needs_attention_at, needs_attention_reason, backup_retention_until
`;

const REQUIRED_PURGE_RECEIPT_DESTINATIONS = new Set([
  "business_database",
  "purge_marker_store",
  ...PURGE_SURFACE_REGISTRY_SNAPSHOT.surfaces
    .map((surface) => surface.receiptDestination)
    .filter((destination) => !destination.startsWith("provider:")),
]);

const FULL_PURGE_COMMAND_TYPE = PURGE_WORKFLOW_SUBJECT_MANIFEST.commandType;
const FULL_PURGE_EVENT_TYPE = PURGE_WORKFLOW_SUBJECT_MANIFEST.eventType;
const FULL_PURGE_SUBJECT_TYPE =
  PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.appUser;

function assertRecoveryMarkerReceipts(
  receipts: readonly Readonly<{
    destination: string;
    destinationDisposition: string;
    providerRetentionUntil: Date | null;
  }>[],
): void {
  const seen = new Set<string>();
  let businessReceiptCount = 0;
  for (const receipt of receipts) {
    if (seen.has(receipt.destination)) {
      throw new PurgeVerificationError("recovery_marker_duplicate_receipt");
    }
    seen.add(receipt.destination);
    if (receipt.destination === "business_database") {
      businessReceiptCount += 1;
      if (
        !["verified_deleted", "not_applicable"].includes(
          receipt.destinationDisposition,
        ) ||
        receipt.providerRetentionUntil !== null
      ) {
        throw new PurgeVerificationError(
          "recovery_marker_business_receipt_invalid",
        );
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
      throw new PurgeVerificationError("recovery_marker_receipt_invalid");
    }
    if (
      receipt.providerRetentionUntil !== null &&
      Number.isNaN(receipt.providerRetentionUntil.getTime())
    ) {
      throw new PurgeVerificationError("recovery_marker_receipt_invalid");
    }
  }
  if (businessReceiptCount !== 1) {
    throw new PurgeVerificationError("recovery_marker_business_receipt_missing");
  }
}

async function assertCompletePurgeReceipts(
  client: PoolClient,
  input: Readonly<{
    ownerPurgeOrderId: string;
    userId: string;
    now: Date;
  }>,
): Promise<void> {
  const result = await client.query<{
    destination: string;
    destination_disposition: string;
    provider_disposition: string | null;
    provider_retention_until: Date | null;
  }>(
    `SELECT destination, destination_disposition, provider_disposition,
            provider_retention_until
     FROM owner_purge_receipts
     WHERE owner_purge_order_id = $1`,
    [input.ownerPurgeOrderId],
  );
  const receipts = new Map(
    result.rows.map((receipt) => [receipt.destination, receipt]),
  );
  const allowedDispositions = new Set([
    "retention_pending",
    "verified_deleted",
    "policy_expired",
    "not_applicable",
  ]);
  for (const receipt of result.rows) {
    const isProviderReceipt =
      receipt.destination.startsWith("provider:") &&
      receipt.destination.length > "provider:".length;
    if (
      !(
        REQUIRED_PURGE_RECEIPT_DESTINATIONS.has(receipt.destination) ||
        isProviderReceipt
      ) ||
      !allowedDispositions.has(receipt.destination_disposition) ||
      (receipt.provider_disposition !== null &&
        !allowedDispositions.has(receipt.provider_disposition)) ||
      (isProviderReceipt && receipt.provider_disposition === null) ||
      (!isProviderReceipt && receipt.provider_disposition !== null) ||
      (isProviderReceipt &&
        receipt.provider_disposition !== receipt.destination_disposition) ||
      (isProviderReceipt &&
        ["retention_pending", "policy_expired"].includes(
          receipt.destination_disposition,
        ) &&
        receipt.provider_retention_until === null) ||
      (isProviderReceipt &&
        receipt.provider_disposition !== null &&
        ["retention_pending", "policy_expired"].includes(
          receipt.provider_disposition,
        ) &&
        receipt.provider_retention_until === null)
    ) {
      throw new PurgeVerificationError("owner_purge_receipt_invalid");
    }
  }
  for (const destination of REQUIRED_PURGE_RECEIPT_DESTINATIONS) {
    const receipt = receipts.get(destination);
    if (
      !receipt ||
      !["verified_deleted", "not_applicable"].includes(
        receipt.destination_disposition,
      ) ||
      receipt.provider_disposition !== null
    ) {
      throw new PurgeVerificationError("owner_purge_receipts_incomplete");
    }
  }
  for (const integration of PURGE_SURFACE_REGISTRY_SNAPSHOT.externalIntegrations) {
    await verifyPurgeSurfaceIntegration(client, integration, {
      now: input.now,
      ownerPurgeOrderId: input.ownerPurgeOrderId,
      userId: input.userId,
    });
  }
}

export class PostgresOwnerPurgeRepository implements OwnerPurgeRepository {
  private readonly purgeRegistry = PURGE_SURFACE_REGISTRY_SNAPSHOT;
  private readonly purgeSurfaces: readonly PurgeSurfaceEntry[];

  public constructor(private readonly pool: Pool) {
    const registry = assertPurgeSurfaceRegistry();
    assertPurgeSurfaceAdapterCoverage(registry);
    this.purgeSurfaces = registry.surfaces;
  }

  public async startOrder(input: {
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
  > {
    const purgeSurfaceRegistryVersion =
      input.purgeSurfaceRegistryVersion ?? PURGE_SURFACE_REGISTRY_VERSION;
    const externalIntegrationManifestVersion =
      input.externalIntegrationManifestVersion ??
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION;
    const workflowSubjectManifestVersion =
      input.workflowSubjectManifestVersion ??
      PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION;
    if (purgeSurfaceRegistryVersion !== PURGE_SURFACE_REGISTRY_VERSION) {
      throw new PurgeVerificationError("purge_surface_registry_version_mismatch");
    }
    if (
      externalIntegrationManifestVersion !==
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION
    ) {
      throw new PurgeVerificationError(
        "external_integration_manifest_version_mismatch",
      );
    }
    if (
      workflowSubjectManifestVersion !==
      PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION
    ) {
      throw new PurgeVerificationError(
        "workflow_subject_manifest_version_mismatch",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      const owner = await client.query<{
        status: string;
        data_epoch: string;
      }>(
        "SELECT status, data_epoch::text FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow) {
        await client.query("ROLLBACK");
        return { outcome: "owner_not_active" };
      }

      if (ownerRow.status !== "active") {
        // A duplicate start while a purge is in flight converges to that
        // order — never a second destructive effect (issue #27 idempotency).
        const inFlight = await client.query<OrderRow>(
          `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
           WHERE user_id = $1 AND status <> 'retention_pending'
           ORDER BY requested_at DESC LIMIT 1`,
          [input.userId],
        );
        await client.query(
          inFlight.rows[0] ? "COMMIT" : "ROLLBACK",
        );
        if (inFlight.rows[0]) {
          return {
            outcome: "started",
            order: mapOrder(inFlight.rows[0]),
            created: false,
          };
        }
        return { outcome: "inconsistent_owner_state" };
      }

      const fromDataEpoch = Number(ownerRow.data_epoch);
      const dataEpoch = fromDataEpoch + 1;
      const orderId = crypto.randomUUID();
      const workflowCommandId = crypto.randomUUID();
      const outboxEventId = crypto.randomUUID();

      const inserted = await client.query<OrderRow>(
        `
          INSERT INTO owner_purge_orders (
            owner_purge_order_id, user_id, from_data_epoch, data_epoch,
            status, confirmation, policy_version, purge_surface_registry_version,
            external_integration_manifest_version,
            workflow_subject_manifest_version, requested_at, last_attempt_at
          )
          VALUES ($1, $2, $3, $4, 'requested', 'PURGE', $5, $6, $7, $8, $9, $9)
          ON CONFLICT (user_id, from_data_epoch) DO NOTHING
          RETURNING ${ORDER_COLUMNS}
        `,
        [
          orderId,
          input.userId,
          fromDataEpoch,
          dataEpoch,
          input.policyVersion,
          purgeSurfaceRegistryVersion,
          externalIntegrationManifestVersion,
          workflowSubjectManifestVersion,
          input.now,
        ],
      );
      if (inserted.rows[0] === undefined) {
        // Defensive convergence: an in-flight order already owns this epoch.
        const existing = await client.query<OrderRow>(
          `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
           WHERE user_id = $1 AND from_data_epoch = $2`,
          [input.userId, fromDataEpoch],
        );
        await client.query("ROLLBACK");
        if (existing.rows[0] && existing.rows[0].status !== "retention_pending") {
          return {
            outcome: "started",
            order: mapOrder(existing.rows[0]),
            created: false,
          };
        }
        return { outcome: "inconsistent_owner_state" };
      }

      // The opening transaction: mark deleting, advance the epoch, revoke
      // undispatched egress authorization, revoke sessions, and create the one
      // idempotent deletion command + outbox event — atomically (arch. 20.3).
      await client.query(
        `UPDATE app_users
         SET status = 'deleting', data_epoch = $2, updated_at = $3
         WHERE user_id = $1`,
        [input.userId, dataEpoch, input.now],
      );
      await client.query(
        `UPDATE provider_egress_consents
         SET status = 'revoked', revoked_at = $2
         WHERE user_id = $1 AND status = 'active'`,
        [input.userId, input.now],
      );
      // Cascades internal_diagnostic_access_grants.
      await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [
        input.userId,
      ]);
      await client.query(
        `
          INSERT INTO workflow_commands (
            workflow_command_id, command_type, subject_type, subject_id,
            source_revision, policy_version, expected_data_epoch, status,
            created_at, purge_surface_registry_version,
            external_integration_manifest_version,
            workflow_subject_manifest_version
          )
          VALUES ($1, '${FULL_PURGE_COMMAND_TYPE}', '${FULL_PURGE_SUBJECT_TYPE}', $2, 0, $3, $4, 'created', $5, $6, $7, $8)
        `,
        [
          workflowCommandId,
          input.userId,
          input.policyVersion,
          dataEpoch,
          input.now,
          purgeSurfaceRegistryVersion,
          externalIntegrationManifestVersion,
          workflowSubjectManifestVersion,
        ],
      );
      await client.query(
        `
          INSERT INTO outbox_events (
            outbox_event_id, workflow_command_id, aggregate_type, aggregate_id,
            aggregate_revision, event_type, status, next_attempt_at,
            attempt_count, payload, created_at, aggregate_coverage,
            aggregate_data_epoch
          )
          VALUES (
            $1, $2, '${FULL_PURGE_SUBJECT_TYPE}', $3, 0, '${FULL_PURGE_EVENT_TYPE}', 'pending',
            $4, 0, $5::jsonb, $4, 0, $6
          )
        `,
        [
          outboxEventId,
          workflowCommandId,
          input.userId,
          input.now,
          JSON.stringify({
            workflowCommandId,
            subjectType: FULL_PURGE_SUBJECT_TYPE,
            subjectId: input.userId,
            expectedDataEpoch: dataEpoch,
            purgeSurfaceRegistryVersion:
              input.purgeSurfaceRegistryVersion ?? PURGE_SURFACE_REGISTRY_VERSION,
            externalIntegrationManifestVersion:
              input.externalIntegrationManifestVersion ??
              PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            workflowSubjectManifestVersion:
              input.workflowSubjectManifestVersion ??
              PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
            eventType: FULL_PURGE_EVENT_TYPE,
            status: "pending",
          }),
          dataEpoch,
        ],
      );

      const created = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1`,
        [orderId],
      );
      await client.query("COMMIT");
      return {
        outcome: "started",
        order: mapOrder(created.rows[0]!),
        created: true,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async findOrder(input: {
    ownerPurgeOrderId: string;
  }): Promise<OwnerPurgeOrder | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
       WHERE owner_purge_order_id = $1`,
      [input.ownerPurgeOrderId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  public async findLatestOrder(input: {
    userId: UserId;
  }): Promise<OwnerPurgeOrder | null> {
    const result = await this.pool.query<OrderRow>(
      `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
       WHERE user_id = $1 ORDER BY requested_at DESC LIMIT 1`,
      [input.userId],
    );
    return result.rows[0] ? mapOrder(result.rows[0]) : null;
  }

  public async listReceipts(input: {
    ownerPurgeOrderId: string;
  }): Promise<readonly OwnerPurgeReceipt[]> {
    const result = await this.pool.query<ReceiptRow>(
      `
        SELECT destination, destination_disposition, provider_disposition,
          provider_retention_until, backup_retention_until, recorded_at
        FROM owner_purge_receipts
        WHERE owner_purge_order_id = $1
        ORDER BY destination
      `,
      [input.ownerPurgeOrderId],
    );
    return result.rows.map(mapReceipt);
  }

  public async verifyRecoveryReceipts(input: {
    ownerPurgeOrderId: string;
    userId: UserId;
    dataEpoch: number;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
        const order = await client.query<{
          user_id: string;
          data_epoch: string;
          status: string;
        }>(
          `SELECT user_id, data_epoch::text, status
           FROM owner_purge_orders
           WHERE owner_purge_order_id = $1
           FOR SHARE`,
          [input.ownerPurgeOrderId],
        );
        const row = order.rows[0];
        if (
          !row ||
          row.user_id !== input.userId ||
          Number(row.data_epoch) !== input.dataEpoch ||
          !["active_system_deleted", "retention_pending"].includes(row.status)
        ) {
          await client.query("ROLLBACK");
          return false;
        }
        await assertCompletePurgeReceipts(client, {
          now: new Date(),
          ownerPurgeOrderId: input.ownerPurgeOrderId,
          userId: input.userId,
        });
      } catch (error) {
        if (
          error instanceof PurgeVerificationError ||
          error instanceof PurgeSurfaceRegistryError
        ) {
          await client.query("ROLLBACK");
          return false;
        }
        throw error;
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original database error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  public async markAttemptStarted(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE owner_purge_orders
       SET last_attempt_at = $2, attempt_count = attempt_count + 1
       WHERE owner_purge_order_id = $1`,
      [input.ownerPurgeOrderId, input.now],
    );
  }

  public async transitionToAccessRevoked(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<
    | Readonly<{ workflowReceiptIds: readonly string[] }>
    | Readonly<{ outcome: "not_applicable" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      const order = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1 FOR UPDATE`,
        [input.ownerPurgeOrderId],
      );
      const row = order.rows[0];
      if (
        !row ||
        !["requested", "access_revoked", "needs_attention"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
      }
      if (isLegacyPurgeVersions(row)) {
        await client.query(
          `UPDATE owner_purge_orders
           SET purge_surface_registry_version = $2,
               external_integration_manifest_version = $3,
               workflow_subject_manifest_version = $4
           WHERE owner_purge_order_id = $1`,
          [
            input.ownerPurgeOrderId,
            PURGE_SURFACE_REGISTRY_VERSION,
            PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
          ],
        );
        await client.query(
          `UPDATE workflow_commands command
           SET purge_surface_registry_version = $2,
               external_integration_manifest_version = $3,
               workflow_subject_manifest_version = $4
           WHERE command.command_type = $5
             AND command.subject_type = $6
             AND command.subject_id = $1
             AND command.expected_data_epoch = $7`,
          [
            row.user_id,
            PURGE_SURFACE_REGISTRY_VERSION,
            PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
            FULL_PURGE_COMMAND_TYPE,
            FULL_PURGE_SUBJECT_TYPE,
            Number(row.data_epoch),
          ],
        );
        await client.query(
          `UPDATE outbox_events event
           SET payload = jsonb_set(
             jsonb_set(
               jsonb_set(
                 event.payload,
                 '{purgeSurfaceRegistryVersion}',
                 to_jsonb($2::text),
                 true
               ),
               '{externalIntegrationManifestVersion}',
               to_jsonb($3::text),
               true
             ),
             '{workflowSubjectManifestVersion}',
             to_jsonb($4::text),
             true
           )
           WHERE event.workflow_command_id IN (
             SELECT command.workflow_command_id
             FROM workflow_commands command
             WHERE command.command_type = $5
               AND command.subject_type = $6
               AND command.subject_id = $1
               AND command.expected_data_epoch = $7
           )`,
          [
            row.user_id,
            PURGE_SURFACE_REGISTRY_VERSION,
            PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
            FULL_PURGE_COMMAND_TYPE,
            FULL_PURGE_SUBJECT_TYPE,
            Number(row.data_epoch),
          ],
        );
      } else {
        assertCurrentPurgeVersions(row);
      }
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'access_revoked',
             access_revoked_at = COALESCE(access_revoked_at, $2),
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now],
      );

      // Batch-cancel every executable command owned by this owner. The purge's
      // own app_user-subject command is excluded and keeps driving propagation.
      const cancelledLeases = await client.query<{ workflow_receipt_id: string | null }>(
        `
          UPDATE outbox_events
          SET status = 'cancelled',
              cancelled_reason = 'owner_purged',
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE status IN ('pending', 'leased')
            AND workflow_command_id IN (
              SELECT workflow_command_id FROM workflow_commands command
              WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
                AND command.command_type <> 'owner_full_purge'
            )
          RETURNING workflow_receipt_id
        `,
        [row.user_id],
      );
      await client.query(
        `
          UPDATE workflow_commands command
          SET status = 'cancelled', cancelled_reason = 'owner_purged'
          WHERE status IN ('created', 'dispatched')
            AND ${OWNER_WORKFLOW_COMMAND_SCOPE}
            AND command.command_type <> 'owner_full_purge'
        `,
        [row.user_id],
      );
      await client.query("COMMIT");
      return {
        workflowReceiptIds: cancelledLeases.rows
          .map((lease) => lease.workflow_receipt_id)
          .filter((id): id is string => id !== null),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async transitionToPropagatingAndClear(input: {
    ownerPurgeOrderId: string;
    providerRetentionUntil?: Date;
    effectivePurgeAt?: Date;
    backupRetentionUntil?: Date | null;
    providerReceipts?: readonly Readonly<{
      destination: string;
      destinationDisposition: string;
      providerRetentionUntil: Date | null;
    }>[];
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "cleared" } & OwnerPurgeClearResult>
    | Readonly<{ outcome: "not_applicable" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1 FOR UPDATE`,
        [input.ownerPurgeOrderId],
      );
      const row = order.rows[0];
      if (!row || !["access_revoked", "needs_attention"].includes(row.status)) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
      }
      assertCurrentPurgeVersions(row);
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      const userId = row.user_id;
      const durableProviderReceipts =
        row.propagating_at === null
          ? undefined
          : (
              await client.query<{
                destination: string;
                destination_disposition: string;
                provider_retention_until: Date | null;
              }>(
                `SELECT destination, destination_disposition,
                        provider_retention_until
                 FROM owner_purge_receipts
                 WHERE owner_purge_order_id = $1
                   AND destination LIKE 'provider:%'
                 ORDER BY destination`,
                [input.ownerPurgeOrderId],
              )
            ).rows.map((receipt) => ({
              destination: receipt.destination,
              destinationDisposition: receipt.destination_disposition,
              providerRetentionUntil: receipt.provider_retention_until,
            }));

      // Purge pass: the transaction-local flag plus the trigger-side
      // in-progress-order verification. Normal-path immutability stays
      // absolute; there is no DISABLE TRIGGER anywhere.
      await client.query("SELECT set_config('sayhear.purge_pass', $1, true)", [
        input.ownerPurgeOrderId,
      ]);

      // Backup retention horizon from the latest verified window.
      const backup = await client.query<{
        longest_known_window_days: number | null;
      }>(
        `
          SELECT longest_known_window_days::float8 AS longest_known_window_days
          FROM backup_policy_versions
          WHERE verification_status = 'verified'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      );
      const windowDays = backup.rows[0]?.longest_known_window_days ?? null;
      const computedBackupRetentionUntil =
        windowDays === null
          ? null
          : new Date(
              input.now.getTime() + Number(windowDays) * 24 * 60 * 60 * 1_000,
            );
      const backupRetentionUntil =
        row.propagating_at !== null
          ? row.backup_retention_until
          : input.backupRetentionUntil === undefined
            ? computedBackupRetentionUntil
            : input.backupRetentionUntil;
      const effectivePurgeAt =
        row.propagating_at ?? input.effectivePurgeAt ?? input.now;

      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'propagating',
             propagating_at = COALESCE(propagating_at, $2),
             backup_retention_until = $3,
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, effectivePurgeAt, backupRetentionUntil],
      );

      // Break circular references before the hard DELETEs.
      await client.query(
        `UPDATE journals SET current_version_id = NULL
         WHERE user_id = $1 AND current_version_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `UPDATE generation_commands SET compiled_context_id = NULL
         WHERE user_id = $1 AND compiled_context_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `UPDATE conversation_events
         SET current_revision_id = NULL, generation_command_id = NULL
         WHERE user_id = $1
           AND (current_revision_id IS NOT NULL OR generation_command_id IS NOT NULL)`,
        [userId],
      );
      // Action finalization rows point back to the action execution from
      // three command surfaces. Break those nullable back-references before
      // the registry reaches the action execution surface.
      await client.query(
        `UPDATE generation_commands
         SET action_execution_id = NULL
         WHERE user_id = $1 AND action_execution_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `UPDATE journal_generation_commands
         SET action_execution_id = NULL
         WHERE user_id = $1 AND action_execution_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `UPDATE workflow_commands command
         SET action_execution_id = NULL
         WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
           AND command.action_execution_id IS NOT NULL`,
        [userId],
      );

      // The registry is the closed coverage boundary. The pointer updates
      // above break circular/back-reference foreign keys; every owner surface
      // is then cleared by its registered adapter in deterministic FK order.
      for (const surface of [...this.purgeSurfaces].sort(
        (left, right) => left.clearOrder - right.clearOrder,
      )) {
        await clearPurgeSurface(client, surface, {
          now: effectivePurgeAt,
          ownerPurgeOrderId: input.ownerPurgeOrderId,
          userId,
        });
      }

      const providerRoles = [] as string[];
      for (const integration of this.purgeRegistry.externalIntegrations) {
        const providerReceipts =
          input.providerReceipts ?? durableProviderReceipts;
        providerRoles.push(
          ...(await clearPurgeSurfaceIntegration(client, integration, {
            now: effectivePurgeAt,
            ownerPurgeOrderId: input.ownerPurgeOrderId,
            userId,
          }, {
            ...(providerReceipts === undefined ? {} : { providerReceipts }),
            ...(providerReceipts === undefined &&
            input.providerRetentionUntil !== undefined
              ? { providerRetentionUntil: input.providerRetentionUntil }
              : {}),
          })),
        );
      }

      await client.query("COMMIT");
      return {
        outcome: "cleared",
        backupRetentionUntil,
        providerRoles: [...new Set(providerRoles)].sort(),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async transitionToVerifying(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "verified" }>
    | Readonly<{ outcome: "not_applicable" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1 FOR UPDATE`,
        [input.ownerPurgeOrderId],
      );
      const row = order.rows[0];
      if (!row || !["propagating", "needs_attention"].includes(row.status)) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
      }
      assertCurrentPurgeVersions(row);
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      const userId = row.user_id;

      // Verification is a distinct dispatch from clearing: no clear adapter
      // may report its own success. Every registered surface is checked by
      // its independent verifier, including retained owner/governance
      // envelopes and the newly added safety/audit surfaces.
      for (const surface of this.purgeSurfaces) {
        await verifyPurgeSurface(client, surface, {
          now: input.now,
          ownerPurgeOrderId: input.ownerPurgeOrderId,
          userId,
        });
      }
      for (const integration of this.purgeRegistry.externalIntegrations) {
        await verifyPurgeSurfaceIntegration(client, integration, {
          now: input.now,
          ownerPurgeOrderId: input.ownerPurgeOrderId,
          userId,
        });
      }
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'verifying',
             verifying_at = COALESCE(verifying_at, $2),
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now],
      );
      await client.query("COMMIT");
      return { outcome: "verified" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async transitionToActiveSystemDeleted(input: {
    ownerPurgeOrderId: string;
    backupRetentionUntil: Date | null;
    effectivePurgeAt?: Date;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "active_system_deleted" }>
    | Readonly<{ outcome: "not_applicable" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1 FOR UPDATE`,
        [input.ownerPurgeOrderId],
      );
      const row = order.rows[0];
      if (
        !row ||
        !["verifying", "active_system_deleted"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
      }
      assertCurrentPurgeVersions(row);
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      if (row.status === "active_system_deleted") {
        await assertCompletePurgeReceipts(client, {
          now: input.now,
          ownerPurgeOrderId: row.owner_purge_order_id,
          userId: row.user_id,
        });
        await client.query("COMMIT");
        return { outcome: "active_system_deleted" };
      }
      const backupRetentionUntil =
        row.backup_retention_until ?? input.backupRetentionUntil;
      for (const destination of ["business_database", "purge_marker_store"]) {
        await client.query(
          `
            INSERT INTO owner_purge_receipts (
              owner_purge_receipt_id, owner_purge_order_id, destination,
              destination_disposition, provider_disposition,
              provider_retention_until, backup_retention_until, recorded_at
            )
            VALUES (
              gen_random_uuid(), $1, $2, 'verified_deleted', NULL, NULL, $3,
              $4
            )
            ON CONFLICT (owner_purge_order_id, destination) DO NOTHING
          `,
          [input.ownerPurgeOrderId, destination, backupRetentionUntil, input.now],
        );
      }
      await assertCompletePurgeReceipts(client, {
        now: input.now,
        ownerPurgeOrderId: input.ownerPurgeOrderId,
        userId: row.user_id,
      });
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'active_system_deleted',
             active_system_deleted_at = COALESCE(active_system_deleted_at, $2),
             backup_retention_until = $3,
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [
          input.ownerPurgeOrderId,
          input.effectivePurgeAt ?? input.now,
          backupRetentionUntil,
        ],
      );
      await client.query("COMMIT");
      return { outcome: "active_system_deleted" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async finalizeRetentionPending(input: {
    ownerPurgeOrderId: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "retention_pending" }>
    | Readonly<{ outcome: "not_applicable" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
         WHERE owner_purge_order_id = $1 FOR UPDATE`,
        [input.ownerPurgeOrderId],
      );
      const row = order.rows[0];
      if (
        !row ||
        !["active_system_deleted", "needs_attention", "retention_pending"].includes(
          row.status,
        )
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
      }
      // Owner revival: the epoch stays advanced, so old data cannot
      // resurrect; purge history lives in owner_purge_orders, not user status.
      await client.query(
        `UPDATE app_users SET status = 'active', updated_at = $2
         WHERE user_id = $1 AND status = 'deleting'`,
        [row.user_id, input.now],
      );
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'retention_pending',
             retention_pending_at = COALESCE(retention_pending_at, $2),
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now],
      );
      // Remove the purge order's own terminal command + outbox event.
      const purgeCommands = await client.query<{ workflow_command_id: string }>(
        `
          SELECT workflow_command_id FROM workflow_commands
          WHERE command_type = $3
            AND subject_type = $4
            AND subject_id = $1
            AND expected_data_epoch = $2
        `,
        [row.user_id, row.data_epoch, FULL_PURGE_COMMAND_TYPE, FULL_PURGE_SUBJECT_TYPE],
      );
      for (const command of purgeCommands.rows) {
        await client.query(
          "DELETE FROM outbox_events WHERE workflow_command_id = $1",
          [command.workflow_command_id],
        );
        await client.query(
          "DELETE FROM workflow_commands WHERE workflow_command_id = $1",
          [command.workflow_command_id],
        );
      }
      await client.query("COMMIT");
      return { outcome: "retention_pending" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async markNeedsAttention(input: {
    ownerPurgeOrderId: string;
    reason: string;
    now: Date;
    expectedStatus?: OwnerPurgeOrder["status"];
  }): Promise<void> {
    await this.pool.query<QueryResultRow>(
      `
        UPDATE owner_purge_orders
        SET status = 'needs_attention',
            needs_attention_at = $2,
            needs_attention_reason = $3
        WHERE owner_purge_order_id = $1
          AND status <> 'retention_pending'
          AND (
            ($4::text IS NOT NULL AND status = $4)
            OR ($4::text IS NULL AND status <> 'active_system_deleted')
          )
      `,
      [input.ownerPurgeOrderId, input.now, input.reason, input.expectedStatus ?? null],
    );
  }

  public async listRetryableOrders(input: {
    now: Date;
    staleAfterMs: number;
    limit: number;
  }): Promise<readonly OwnerPurgeOrder[]> {
    const result = await this.pool.query<OrderRow>(
      `
        SELECT ${ORDER_COLUMNS} FROM owner_purge_orders
        WHERE status <> 'retention_pending'
          AND (
            status = 'needs_attention'
            OR last_attempt_at <= $1::timestamptz - $2::interval
          )
        ORDER BY requested_at
        LIMIT $3
      `,
      [input.now, `${input.staleAfterMs} milliseconds`, input.limit],
    );
    return result.rows.map(mapOrder);
  }

  public async sweepExpiredMetadata(input: {
    now: Date;
  }): Promise<Readonly<{ deleted: number }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      let deleted = 0;
      for (const surface of this.purgeSurfaces) {
        deleted += await sweepExpiredPurgeSurface(client, surface, input.now);
      }
      await client.query("COMMIT");
      return { deleted };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async reapplyMarker(input: {
    userId: UserId;
    dataEpoch: number;
    purgedAt: Date;
    backupRetentionUntil: Date | null;
    receipts: readonly Readonly<{
      destination: string;
      destinationDisposition: string;
      providerRetentionUntil: Date | null;
    }>[];
    now: Date;
  }): Promise<Readonly<{ outcome: "reapplied" }>> {
    const client = await this.pool.connect();
    let orderId: string;
    try {
      await client.query("BEGIN");
      await assertPurgeSurfaceDatabaseInventory(client, this.purgeRegistry);
      assertRecoveryMarkerReceipts(input.receipts);
      const owner = await client.query<{
        data_epoch: string;
        status: "active" | "deleting" | "disabled";
      }>(
        "SELECT data_epoch::text, status FROM app_users WHERE user_id = $1 FOR UPDATE",
        [input.userId],
      );
      const ownerRow = owner.rows[0];
      if (!ownerRow || Number(ownerRow.data_epoch) > input.dataEpoch) {
        await client.query("ROLLBACK");
        throw new Error("recovery_marker_is_older_than_business_database");
      }

      const existing = await client.query<{
        owner_purge_order_id: string;
        status: string;
        purge_surface_registry_version: string;
        external_integration_manifest_version: string;
        workflow_subject_manifest_version: string;
      }>(
        `SELECT owner_purge_order_id, status, purge_surface_registry_version,
                external_integration_manifest_version,
                workflow_subject_manifest_version
         FROM owner_purge_orders
         WHERE user_id = $1 AND data_epoch = $2
         ORDER BY requested_at DESC LIMIT 1`,
        [input.userId, input.dataEpoch],
      );
      orderId = existing.rows[0]?.owner_purge_order_id ?? crypto.randomUUID();
      if (existing.rows[0]) {
        if (
          !isCurrentPurgeVersions(existing.rows[0]) &&
          !isLegacyPurgeVersions(existing.rows[0])
        ) {
          throw new PurgeVerificationError(
            "recovery_marker_purge_versions_unrecognized",
          );
        }
        // A restored database may contain the terminal order from the backup
        // that produced the marker. Reopen that order for a real clear pass;
        // the explicit recovery action upgrades legacy provenance to the
        // current executable manifests. Keeping the original active timestamp
        // prevents a reapply from extending the metadata read window.
        await client.query(
          `UPDATE owner_purge_orders
           SET status = 'access_revoked',
               purge_surface_registry_version = $4,
               external_integration_manifest_version = $5,
               workflow_subject_manifest_version = $6,
               access_revoked_at = COALESCE(access_revoked_at, $2),
               propagating_at = NULL,
               verifying_at = NULL,
               retention_pending_at = NULL,
               needs_attention_at = NULL,
               needs_attention_reason = NULL,
               backup_retention_until = $3,
               last_attempt_at = $2
           WHERE owner_purge_order_id = $1`,
          [
            orderId,
            input.now,
            input.backupRetentionUntil,
            PURGE_SURFACE_REGISTRY_VERSION,
            PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
          ],
        );
      } else {
        const fromDataEpoch = Math.max(1, input.dataEpoch - 1);
        await client.query(
          `INSERT INTO owner_purge_orders (
             owner_purge_order_id, user_id, from_data_epoch, data_epoch,
             status, confirmation, policy_version,
             purge_surface_registry_version,
             external_integration_manifest_version,
             workflow_subject_manifest_version, requested_at, last_attempt_at
           ) VALUES ($1, $2, $3, $4, 'requested', 'PURGE',
             'recovery-marker-reapply:v1', $5, $6, $7, $8, $8)`,
          [
            orderId,
            input.userId,
            fromDataEpoch,
            input.dataEpoch,
            PURGE_SURFACE_REGISTRY_VERSION,
            PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
            PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
            input.now,
          ],
        );
      }
      // The restored order's old receipts are not authoritative. The marker
      // is the recovery source of truth; the reapply pass recreates local
      // business/provider receipts from it and then verifies them independently.
      await client.query(
        "DELETE FROM owner_purge_receipts WHERE owner_purge_order_id = $1",
        [orderId],
      );
      await client.query(
        `UPDATE app_users
         SET status = 'deleting', data_epoch = $2, updated_at = $3
         WHERE user_id = $1`,
        [input.userId, input.dataEpoch, input.now],
      );
      await client.query(
        `UPDATE provider_egress_consents
         SET status = 'revoked', revoked_at = $2
         WHERE user_id = $1 AND status = 'active'`,
        [input.userId, input.now],
      );
      await client.query("DELETE FROM auth_sessions WHERE user_id = $1", [
        input.userId,
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const now = input.now;
    try {
      await this.transitionToAccessRevoked({ ownerPurgeOrderId: orderId!, now });
      await this.transitionToPropagatingAndClear({
        backupRetentionUntil: input.backupRetentionUntil,
        effectivePurgeAt: input.purgedAt,
        ownerPurgeOrderId: orderId!,
        providerReceipts: input.receipts.filter((receipt) =>
          receipt.destination.startsWith("provider:"),
        ),
        now,
      });
      await this.transitionToVerifying({ ownerPurgeOrderId: orderId!, now });
      await this.transitionToActiveSystemDeleted({
        backupRetentionUntil: input.backupRetentionUntil,
        effectivePurgeAt: input.purgedAt,
        ownerPurgeOrderId: orderId!,
        now,
      });
      await this.finalizeRetentionPending({ ownerPurgeOrderId: orderId!, now });
    } catch (error) {
      await this.markNeedsAttention({
        ownerPurgeOrderId: orderId!,
        reason: "recovery_reapply_failed",
        now,
      });
      throw error;
    }
    return { outcome: "reapplied" };
  }
}
