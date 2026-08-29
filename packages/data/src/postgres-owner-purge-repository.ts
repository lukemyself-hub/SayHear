import type {
  OwnerPurgeClearResult,
  OwnerPurgeOrder,
  OwnerPurgeOrderStatus,
  OwnerPurgeReceipt,
  OwnerPurgeRepository,
} from "@sayhear/application";
import { PurgeVerificationError } from "@sayhear/application";
import { asUserId, type UserId } from "@sayhear/domain";
import type { Pool, QueryResultRow } from "pg";

type OrderRow = Readonly<{
  owner_purge_order_id: string;
  user_id: string;
  from_data_epoch: string;
  data_epoch: string;
  status: string;
  policy_version: string;
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

function mapOrder(row: OrderRow): OwnerPurgeOrder {
  return {
    ownerPurgeOrderId: row.owner_purge_order_id,
    userId: asUserId(row.user_id),
    fromDataEpoch: Number(row.from_data_epoch),
    dataEpoch: Number(row.data_epoch),
    status: row.status as OwnerPurgeOrderStatus,
    policyVersion: row.policy_version,
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
  status, policy_version, requested_at, access_revoked_at, propagating_at,
  verifying_at, active_system_deleted_at, retention_pending_at,
  needs_attention_at, needs_attention_reason, backup_retention_until
`;

// workflow_commands is deliberately polymorphic: its subject has no foreign
// key because the command vocabulary spans tables introduced over time. Keep
// this scope expression in one place so every purge delete and its immediate
// verification use the same owner-bound subject set.
const OWNER_WORKFLOW_COMMAND_SCOPE = `(
  (
    command.subject_type = 'daily_session'
    AND command.subject_id IN (
      SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = 'conversation_event_revision'
    AND command.subject_id IN (
      SELECT conversation_event_revision_id
      FROM conversation_event_revisions WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = 'memory_claim'
    AND command.subject_id IN (
      SELECT memory_claim_id FROM memory_claims WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = 'entity'
    AND command.subject_id IN (
      SELECT entity_id FROM entities WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = 'app_user'
    AND command.subject_id = $1
  )
)`;

/**
 * Every owner-scoped surface present through 1A.3a that the Full Purge clears,
 * with the count query verification uses. Conversation Event Revisions are
 * intentionally absent: they survive as content-free tombstoned envelopes
 * (content_purged_at + empty canonical_text) per the issue #27 clearing
 * strategy.
 */
const CLEARED_SURFACES: ReadonlyArray<Readonly<{
  label: string;
  params?: string[];
  sql: string;
}>> = [
  { label: "daily_sessions", sql: "SELECT count(*) FROM daily_sessions WHERE user_id = $1" },
  { label: "interaction_turns", sql: "SELECT count(*) FROM interaction_turns WHERE user_id = $1" },
  { label: "conversation_events", sql: "SELECT count(*) FROM conversation_events WHERE user_id = $1" },
  { label: "generation_commands", sql: "SELECT count(*) FROM generation_commands WHERE user_id = $1" },
  { label: "model_run_attempts", sql: "SELECT count(*) FROM model_run_attempts WHERE user_id = $1" },
  { label: "compiled_contexts", sql: "SELECT count(*) FROM compiled_contexts WHERE user_id = $1" },
  { label: "compiled_context_revision_refs", sql: "SELECT count(*) FROM compiled_context_revision_refs WHERE user_id = $1" },
  { label: "provider_egress_dispositions", sql: "SELECT count(*) FROM provider_egress_dispositions WHERE user_id = $1" },
  { label: "provider_egress_consents", sql: "SELECT count(*) FROM provider_egress_consents WHERE user_id = $1" },
  { label: "continuous_exchange_inactivity_evaluations", sql: "SELECT count(*) FROM continuous_exchange_inactivity_evaluations WHERE user_id = $1" },
  { label: "evidence_source_snapshots", sql: "SELECT count(*) FROM evidence_source_snapshots WHERE user_id = $1" },
  { label: "evidence_items", sql: "SELECT count(*) FROM evidence_items WHERE user_id = $1" },
  { label: "evidence_lineage", sql: "SELECT count(*) FROM evidence_lineage WHERE evidence_item_id IN (SELECT evidence_item_id FROM evidence_items WHERE user_id = $1)" },
  { label: "evidence_model_run_attempts", sql: "SELECT count(*) FROM evidence_model_run_attempts WHERE evidence_source_snapshot_id IN (SELECT evidence_source_snapshot_id FROM evidence_source_snapshots WHERE user_id = $1)" },
  { label: "journals", sql: "SELECT count(*) FROM journals WHERE user_id = $1" },
  { label: "journal_versions", sql: "SELECT count(*) FROM journal_versions WHERE user_id = $1" },
  { label: "journal_diagnostic_findings", sql: "SELECT count(*) FROM journal_diagnostic_findings WHERE journal_statement_id IN (SELECT journal_statement_id FROM journal_statements WHERE user_id = $1)" },
  { label: "journal_statements", sql: "SELECT count(*) FROM journal_statements WHERE user_id = $1" },
  { label: "journal_statement_evidence_links", sql: "SELECT count(*) FROM journal_statement_evidence_links WHERE user_id = $1" },
  { label: "journal_statement_entity_links", sql: "SELECT count(*) FROM journal_statement_entity_links WHERE user_id = $1" },
  { label: "journal_identity_review_fences", sql: "SELECT count(*) FROM journal_identity_review_fences WHERE user_id = $1" },
  { label: "entity_identity_corrections", sql: "SELECT count(*) FROM entity_identity_corrections WHERE user_id = $1" },
  { label: "entity_identity_revalidation_runs", sql: "SELECT count(*) FROM entity_identity_revalidation_runs WHERE user_id = $1" },
  { label: "journal_validation_results", sql: "SELECT count(*) FROM journal_validation_results WHERE daily_session_id IN (SELECT daily_session_id FROM daily_sessions WHERE user_id = $1)" },
  { label: "journal_generation_commands", sql: "SELECT count(*) FROM journal_generation_commands WHERE user_id = $1" },
  { label: "journal_model_run_attempts", sql: "SELECT count(*) FROM journal_model_run_attempts WHERE generation_command_id IN (SELECT generation_command_id FROM journal_generation_commands WHERE user_id = $1)" },
  { label: "journal_workflow_outcomes", sql: "SELECT count(*) FROM journal_workflow_outcomes WHERE user_id = $1" },
  { label: "rolling_summary_commands", sql: "SELECT count(*) FROM rolling_summary_commands WHERE user_id = $1" },
  { label: "rolling_summary_versions", sql: "SELECT count(*) FROM rolling_summary_versions WHERE user_id = $1" },
  { label: "current_rolling_summaries", sql: "SELECT count(*) FROM current_rolling_summaries WHERE daily_session_id IN (SELECT daily_session_id FROM daily_sessions WHERE user_id = $1)" },
  { label: "dialogue_state_commands", sql: "SELECT count(*) FROM dialogue_state_commands WHERE user_id = $1" },
  { label: "dialogue_state_versions", sql: "SELECT count(*) FROM dialogue_state_versions WHERE user_id = $1" },
  { label: "current_dialogue_states", sql: "SELECT count(*) FROM current_dialogue_states WHERE daily_session_id IN (SELECT daily_session_id FROM daily_sessions WHERE user_id = $1)" },
  { label: "daily_session_date_outcomes", sql: "SELECT count(*) FROM daily_session_date_outcomes WHERE user_id = $1" },
  { label: "auth_sessions", sql: "SELECT count(*) FROM auth_sessions WHERE user_id = $1" },
  { label: "entity_labels", sql: "SELECT count(*) FROM entity_labels WHERE user_id = $1" },
  { label: "entity_mentions", sql: "SELECT count(*) FROM entity_mentions WHERE user_id = $1" },
  { label: "entity_mention_candidates", sql: "SELECT count(*) FROM entity_mention_candidates WHERE user_id = $1" },
  { label: "memory_candidates", sql: "SELECT count(*) FROM memory_candidates WHERE user_id = $1" },
  { label: "memory_candidate_evidence_links", sql: "SELECT count(*) FROM memory_candidate_evidence_links WHERE user_id = $1" },
  { label: "memory_forget_requests", sql: "SELECT count(*) FROM memory_forget_requests WHERE user_id = $1" },
  { label: "memory_forget_evidence_exclusions", sql: "SELECT count(*) FROM memory_forget_evidence_exclusions WHERE user_id = $1" },
  { label: "memory_forget_reversals", sql: "SELECT count(*) FROM memory_forget_reversals WHERE user_id = $1" },
  { label: "relationship_resolver_hints", sql: "SELECT count(*) FROM relationship_resolver_hints WHERE user_id = $1" },
  { label: "claim_evidence_links", sql: "SELECT count(*) FROM claim_evidence_links WHERE user_id = $1" },
  { label: "memory_claim_version_qualifier_evidence", sql: "SELECT count(*) FROM memory_claim_version_qualifier_evidence WHERE user_id = $1" },
  { label: "claim_retrieval_projections", sql: "SELECT count(*) FROM claim_retrieval_projections WHERE user_id = $1" },
  { label: "retrieval_run_candidates", sql: "SELECT count(*) FROM retrieval_run_candidates WHERE user_id = $1" },
  { label: "retrieval_runs", sql: "SELECT count(*) FROM retrieval_runs WHERE user_id = $1" },
  { label: "fast_path_session_items", sql: "SELECT count(*) FROM fast_path_session_items WHERE user_id = $1" },
  { label: "entity_resolve_gate_outcomes", sql: "SELECT count(*) FROM entity_resolve_gate_outcomes WHERE user_id = $1" },
  { label: "entity_clarification_proposals", sql: "SELECT count(*) FROM entity_clarification_proposals WHERE user_id = $1" },
  { label: "fast_path_extraction_runs", sql: "SELECT count(*) FROM fast_path_extraction_runs WHERE user_id = $1" },
  { label: "memory_consolidation_diffs", sql: "SELECT count(*) FROM memory_consolidation_diffs WHERE user_id = $1" },
  { label: "memory_consolidation_runs", sql: "SELECT count(*) FROM memory_consolidation_runs WHERE user_id = $1" },
  { label: "memory_claim_corrections", sql: "SELECT count(*) FROM memory_claim_corrections WHERE user_id = $1" },
  { label: "memory_impression_vetoes", sql: "SELECT count(*) FROM memory_impression_vetoes WHERE user_id = $1" },
  { label: "memory_correction_followups", sql: "SELECT count(*) FROM memory_correction_followups WHERE user_id = $1" },
  { label: "conversation_action_handles", sql: "SELECT count(*) FROM conversation_action_handles WHERE user_id = $1" },
  { label: "conversation_action_payloads", sql: "SELECT count(*) FROM conversation_action_payloads WHERE action_execution_id IN (SELECT action_execution_id FROM conversation_action_executions WHERE user_id = $1)" },
  { label: "conversation_action_receipts", sql: "SELECT count(*) FROM conversation_action_receipts WHERE action_execution_id IN (SELECT action_execution_id FROM conversation_action_executions WHERE user_id = $1)" },
  { label: "conversation_action_executions", sql: "SELECT count(*) FROM conversation_action_executions WHERE user_id = $1" },
  // Source-ref tables have no user_id and are cleared by ON DELETE CASCADE
  // from their commands; verification asserts no orphans survived.
  { label: "rolling_summary_command_source_refs", params: [], sql: "SELECT count(*) FROM rolling_summary_command_source_refs ref LEFT JOIN rolling_summary_commands command ON command.rolling_summary_command_id = ref.rolling_summary_command_id WHERE command.rolling_summary_command_id IS NULL" },
  { label: "dialogue_state_command_source_refs", params: [], sql: "SELECT count(*) FROM dialogue_state_command_source_refs ref LEFT JOIN dialogue_state_commands command ON command.dialogue_state_command_id = ref.dialogue_state_command_id WHERE command.dialogue_state_command_id IS NULL" },
];

/**
 * Immutable EntityVersion / ClaimVersion rows cannot be deleted without
 * breaking their history contract. Full Purge therefore leaves only their
 * contentless tombstone markers; no current pointer or readable owner row may
 * survive. The Self Entity's active envelope is deliberately excluded.
 */
const PURGED_MEMORY_SURFACES: ReadonlyArray<Readonly<{
  label: string;
  sql: string;
}>> = [
  {
    label: "memory_claims_not_purged",
    sql: `
      SELECT count(*)
      FROM memory_claims claim
      WHERE claim.user_id = $1
        AND (
          claim.current_version_id IS NOT NULL
          OR claim.deleted_at IS NULL
          OR claim.content_purged_at IS NULL
        )
    `,
  },
  {
    label: "memory_claim_versions_not_purged",
    sql: `
      SELECT count(*)
      FROM memory_claim_versions version
      WHERE version.user_id = $1
        AND version.content_purged_at IS NULL
    `,
  },
  {
    label: "memory_claim_version_qualifiers_not_purged",
    sql: `
      SELECT count(*)
      FROM memory_claim_version_qualifiers qualifier
      WHERE qualifier.user_id = $1
        AND qualifier.content_purged_at IS NULL
    `,
  },
  {
    label: "ordinary_entities_not_purged",
    sql: `
      SELECT count(*)
      FROM entities entity
      WHERE entity.user_id = $1
        AND NOT EXISTS (
          SELECT 1
          FROM user_self_entities binding
          WHERE binding.user_id = $1
            AND binding.entity_id = entity.entity_id
        )
        AND (
          entity.current_version_id IS NOT NULL
          OR entity.deleted_at IS NULL
        )
    `,
  },
  {
    label: "ordinary_entity_versions_not_purged",
    sql: `
      SELECT count(*)
      FROM entity_versions version
      WHERE version.user_id = $1
        AND version.content_purged_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM user_self_entities binding
          WHERE binding.user_id = $1
            AND binding.entity_id = version.entity_id
        )
    `,
  },
];

export class PostgresOwnerPurgeRepository implements OwnerPurgeRepository {
  public constructor(private readonly pool: Pool) {}

  public async startOrder(input: {
    userId: UserId;
    confirmation: "PURGE";
    policyVersion: string;
    now: Date;
  }): Promise<
    | Readonly<{ outcome: "started"; order: OwnerPurgeOrder; created: boolean }>
    | Readonly<{ outcome: "owner_not_active" }>
    | Readonly<{ outcome: "inconsistent_owner_state" }>
  > {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
            status, confirmation, policy_version, requested_at, last_attempt_at
          )
          VALUES ($1, $2, $3, $4, 'requested', 'PURGE', $5, $6, $6)
          ON CONFLICT (user_id, from_data_epoch) DO NOTHING
          RETURNING ${ORDER_COLUMNS}
        `,
        [orderId, input.userId, fromDataEpoch, dataEpoch, input.policyVersion, input.now],
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
            created_at
          )
          VALUES ($1, 'owner_full_purge', 'app_user', $2, 0, $3, $4, 'created', $5)
        `,
        [workflowCommandId, input.userId, input.policyVersion, dataEpoch, input.now],
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
            $1, $2, 'app_user', $3, 0, 'owner_full_purge_requested', 'pending',
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
            subjectType: "app_user",
            subjectId: input.userId,
            expectedDataEpoch: dataEpoch,
            eventType: "owner_full_purge_requested",
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
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'access_revoked',
             access_revoked_at = COALESCE(access_revoked_at, $2),
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now],
      );

      // Batch-cancel every executable command owned by this owner's Daily
      // Sessions. The purge's own app_user-subject command is excluded by the
      // subject_type filter and keeps driving propagation.
      const cancelledLeases = await client.query<{ workflow_receipt_id: string | null }>(
        `
          UPDATE outbox_events
          SET status = 'cancelled',
              cancelled_reason = 'owner_purged',
              lease_owner = NULL,
              lease_expires_at = NULL
          WHERE status IN ('pending', 'leased')
            AND workflow_command_id IN (
              SELECT workflow_command_id FROM workflow_commands
              WHERE subject_type = 'daily_session'
                AND subject_id IN (
                  SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
                )
            )
          RETURNING workflow_receipt_id
        `,
        [row.user_id],
      );
      await client.query(
        `
          UPDATE workflow_commands
          SET status = 'cancelled', cancelled_reason = 'owner_purged'
          WHERE status IN ('created', 'dispatched')
            AND subject_type = 'daily_session'
            AND subject_id IN (
              SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
            )
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
    providerRetentionUntil: Date;
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
      const userId = row.user_id;

      // Purge pass: the transaction-local flag plus the trigger-side
      // in-progress-order verification. Normal-path immutability stays
      // absolute; there is no DISABLE TRIGGER anywhere.
      await client.query("SELECT set_config('sayhear.purge_pass', $1, true)", [
        input.ownerPurgeOrderId,
      ]);

      // Capture provider roles BEFORE the deletes so receipts reflect what
      // actually received owner data (issue #27, architecture 18.4).
      const roles = new Set<string>();
      const conversationRole = await client.query(
        "SELECT 1 FROM provider_egress_dispositions WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      if (conversationRole.rowCount) {
        roles.add("conversation.text");
      }
      const journalRoles = await client.query<{ role: string }>(
        `
          SELECT DISTINCT attempt.role
          FROM journal_model_run_attempts attempt
          INNER JOIN journal_generation_commands command
            ON command.generation_command_id = attempt.generation_command_id
          WHERE command.user_id = $1
        `,
        [userId],
      );
      for (const attempt of journalRoles.rows) {
        roles.add(attempt.role);
      }
      const evidenceRole = await client.query(
        `
          SELECT 1 FROM evidence_model_run_attempts attempt
          INNER JOIN evidence_source_snapshots snapshot
            ON snapshot.evidence_source_snapshot_id = attempt.evidence_source_snapshot_id
          WHERE snapshot.user_id = $1 LIMIT 1
        `,
        [userId],
      );
      if (evidenceRole.rowCount) {
        roles.add("evidence.extract");
      }
      const summaryRole = await client.query(
        "SELECT 1 FROM rolling_summary_versions WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      if (summaryRole.rowCount) {
        roles.add("summary.compress");
      }
      const dialogueRole = await client.query(
        "SELECT 1 FROM dialogue_state_versions WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      if (dialogueRole.rowCount) {
        roles.add("dialogue.state");
      }

      // Backup retention horizon from the latest verified window.
      const backup = await client.query<{
        longest_known_window_days: number | null;
      }>(
        `
          SELECT longest_known_window_days
          FROM backup_policy_versions
          WHERE verification_status = 'verified'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      );
      const windowDays = backup.rows[0]?.longest_known_window_days ?? null;
      const backupRetentionUntil = windowDays
        ? new Date(input.now.getTime() + windowDays * 24 * 60 * 60 * 1_000)
        : null;

      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'propagating',
             propagating_at = COALESCE(propagating_at, $2),
             backup_retention_until = $3,
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now, backupRetentionUntil],
      );

      // Tombstone Conversation Event Revision content (Foundation-designed
      // transition; readers already fail closed on content_purged_at).
      await client.query(
        `
          UPDATE conversation_event_revisions
          SET content_purged_at = $2, canonical_text = ''
          WHERE user_id = $1 AND content_purged_at IS NULL
        `,
        [userId, input.now],
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

      // Memory logical identities and immutable history retain only the
      // content-free envelopes allowed by ADR-0074. Clear every current
      // pointer first so no reader can reach a purged version while the
      // dependent projections are being removed. The Self Entity envelope
      // and its one-to-one binding are intentionally excluded.
      await client.query(
        `UPDATE memory_claims
         SET current_version_id = NULL
         WHERE user_id = $1 AND current_version_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `UPDATE entities entity
         SET current_version_id = NULL
         WHERE entity.user_id = $1
           AND entity.current_version_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = entity.entity_id
           )`,
        [userId],
      );
      await client.query(
        `UPDATE memory_claims
         SET deleted_at = COALESCE(deleted_at, $2),
             content_purged_at = COALESCE(content_purged_at, $2)
         WHERE user_id = $1`,
        [userId, input.now],
      );
      await client.query(
        `UPDATE memory_claim_versions
         SET content_purged_at = $2,
             typed_value = NULL
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [userId, input.now],
      );
      await client.query(
        `UPDATE memory_claim_version_qualifiers
         SET content_purged_at = $2,
             typed_value = NULL
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [userId, input.now],
      );
      await client.query(
        `UPDATE entity_versions version
         SET content_purged_at = $2
         WHERE version.user_id = $1
           AND version.content_purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = version.entity_id
           )`,
        [userId, input.now],
      );
      await client.query(
        `UPDATE entities entity
         SET deleted_at = COALESCE(deleted_at, $2)
         WHERE entity.user_id = $1
           AND entity.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = entity.entity_id
           )`,
        [userId, input.now],
      );

      // Hard-DELETE every other owner-scoped surface, FK-safe order.
      await client.query(
        "DELETE FROM entity_identity_revalidation_runs WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM journal_identity_review_fences WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM journal_statement_entity_links WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM entity_identity_corrections WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_correction_followups WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_claim_corrections WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_impression_vetoes WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_consolidation_diffs WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_consolidation_runs WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM fast_path_session_items WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM entity_resolve_gate_outcomes WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM entity_clarification_proposals WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM fast_path_extraction_runs WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM retrieval_run_candidates WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM retrieval_runs WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM relationship_resolver_hints WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM claim_retrieval_projections WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_claim_version_qualifier_evidence WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM claim_evidence_links WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_candidate_evidence_links WHERE user_id = $1",
        [userId],
      );
      await client.query("DELETE FROM memory_candidates WHERE user_id = $1", [userId]);
      await client.query(
        "DELETE FROM memory_forget_reversals WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_forget_evidence_exclusions WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM memory_forget_requests WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM entity_mention_candidates WHERE user_id = $1",
        [userId],
      );
      await client.query("DELETE FROM entity_mentions WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM entity_labels WHERE user_id = $1", [userId]);

      // These action rows carry typed Claim / Qualifier / Entity references.
      // Remove every owner workflow and outbox record first, then the
      // content-bearing action envelope, before the old 1A.2 tables below.
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
        `DELETE FROM outbox_events
         WHERE workflow_command_id IN (
           SELECT workflow_command_id
           FROM workflow_commands command
           WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
           AND command.command_type <> 'owner_full_purge'
         )`,
        [userId],
      );
      await client.query(
        `DELETE FROM workflow_commands command
         WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
         AND command.command_type <> 'owner_full_purge'`,
        [userId],
      );
      const remainingWorkflowCommands = await client.query<{ count: string }>(
        `SELECT count(*) AS count
         FROM workflow_commands command
         WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
           AND command.command_type <> 'owner_full_purge'`,
        [userId],
      );
      if (Number(remainingWorkflowCommands.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("workflow_commands_not_cleared");
      }
      await client.query(
        "DELETE FROM conversation_action_handles WHERE user_id = $1",
        [userId],
      );
      await client.query(
        `DELETE FROM conversation_action_receipts receipt
         USING conversation_action_executions execution
         WHERE receipt.action_execution_id = execution.action_execution_id
           AND execution.user_id = $1`,
        [userId],
      );
      await client.query(
        `DELETE FROM conversation_action_payloads payload
         USING conversation_action_executions execution
         WHERE payload.action_execution_id = execution.action_execution_id
           AND execution.user_id = $1`,
        [userId],
      );
      await client.query(
        "DELETE FROM conversation_action_executions WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM journal_statement_evidence_links WHERE user_id = $1",
        [userId],
      );
      await client.query(
        `DELETE FROM journal_diagnostic_findings
         WHERE journal_statement_id IN (
           SELECT journal_statement_id FROM journal_statements WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query("DELETE FROM journal_statements WHERE user_id = $1", [userId]);
      await client.query(
        `DELETE FROM journal_validation_results
         WHERE daily_session_id IN (
           SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query("DELETE FROM journal_versions WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM journals WHERE user_id = $1", [userId]);
      await client.query(
        `DELETE FROM journal_model_run_attempts
         WHERE generation_command_id IN (
           SELECT generation_command_id FROM journal_generation_commands
           WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query(
        "DELETE FROM journal_generation_commands WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM journal_workflow_outcomes WHERE user_id = $1",
        [userId],
      );
      await client.query(
        `DELETE FROM evidence_lineage
         WHERE evidence_item_id IN (
           SELECT evidence_item_id FROM evidence_items WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query("DELETE FROM evidence_items WHERE user_id = $1", [userId]);
      await client.query(
        `DELETE FROM evidence_model_run_attempts
         WHERE evidence_source_snapshot_id IN (
           SELECT evidence_source_snapshot_id FROM evidence_source_snapshots
           WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query(
        "DELETE FROM evidence_source_snapshots WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM daily_session_date_outcomes WHERE user_id = $1",
        [userId],
      );
      await client.query(
        `DELETE FROM current_rolling_summaries
         WHERE daily_session_id IN (
           SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query(
        "DELETE FROM rolling_summary_versions WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM rolling_summary_commands WHERE user_id = $1",
        [userId],
      );
      await client.query(
        `DELETE FROM current_curiosity_stop_signals
        WHERE daily_session_id IN (
          SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
        )`,
        [userId],
      );
      await client.query(
        `DELETE FROM curiosity_stop_signals WHERE user_id = $1`,
        [userId],
      );
      await client.query(
        `DELETE FROM current_dialogue_states
         WHERE daily_session_id IN (
           SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
         )`,
        [userId],
      );
      await client.query(
        "DELETE FROM dialogue_state_versions WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM dialogue_state_commands WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM continuous_exchange_inactivity_evaluations WHERE user_id = $1",
        [userId],
      );
      await client.query(
        "DELETE FROM compiled_context_revision_refs WHERE user_id = $1",
        [userId],
      );
      await client.query("DELETE FROM compiled_contexts WHERE user_id = $1", [userId]);
      await client.query(
        "DELETE FROM provider_egress_dispositions WHERE user_id = $1",
        [userId],
      );
      await client.query("DELETE FROM model_run_attempts WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM generation_commands WHERE user_id = $1", [userId]);
      await client.query(
        `DELETE FROM outbox_events
         WHERE workflow_command_id IN (
           SELECT workflow_command_id FROM workflow_commands
           WHERE subject_type = 'daily_session'
             AND subject_id IN (
               SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
             )
         )`,
        [userId],
      );
      await client.query(
        `
          DELETE FROM workflow_commands
          WHERE subject_type = 'daily_session'
            AND subject_id IN (
              SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
            )
        `,
        [userId],
      );
      await client.query("DELETE FROM conversation_events WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM interaction_turns WHERE user_id = $1", [userId]);
      await client.query("DELETE FROM daily_sessions WHERE user_id = $1", [userId]);
      // Egress authorization was revoked in the opening transaction; clear the
      // rows with the rest of the epoch's data.
      await client.query("DELETE FROM provider_egress_consents WHERE user_id = $1", [
        userId,
      ]);

      // Content-free Provider receipts: documented retention policy only —
      // no Provider deletion API calls exist in 1A.2 (ADR-0022).
      for (const role of roles) {
        await client.query(
          `
            INSERT INTO owner_purge_receipts (
              owner_purge_receipt_id, owner_purge_order_id, destination,
              destination_disposition, provider_disposition,
              provider_retention_until, recorded_at
            )
            VALUES (
              gen_random_uuid(), $1, $2, 'retention_pending', 'retention_pending',
              $3, $4
            )
            ON CONFLICT (owner_purge_order_id, destination) DO NOTHING
          `,
          [
            input.ownerPurgeOrderId,
            `provider:${role}`,
            input.providerRetentionUntil,
            input.now,
          ],
        );
      }

      await client.query("COMMIT");
      return {
        outcome: "cleared",
        backupRetentionUntil,
        providerRoles: [...roles].sort(),
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
      const userId = row.user_id;

      for (const surface of CLEARED_SURFACES) {
        const count = await client.query<{ count: string }>(
          surface.sql,
          surface.params ?? [userId],
        );
        if (Number(count.rows[0]?.count ?? 0) > 0) {
          await client.query("ROLLBACK");
          throw new PurgeVerificationError(`${surface.label}_not_empty`);
        }
      }
      for (const surface of PURGED_MEMORY_SURFACES) {
        const count = await client.query<{ count: string }>(surface.sql, [userId]);
        if (Number(count.rows[0]?.count ?? 0) > 0) {
          await client.query("ROLLBACK");
          throw new PurgeVerificationError(`${surface.label}`);
        }
      }
      const unpurged = await client.query<{ count: string }>(
        `
          SELECT count(*) AS count FROM conversation_event_revisions
          WHERE user_id = $1 AND content_purged_at IS NULL
        `,
        [userId],
      );
      if (Number(unpurged.rows[0]?.count ?? 0) > 0) {
        await client.query("ROLLBACK");
        throw new PurgeVerificationError("revisions_not_purged");
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
        !["verifying", "needs_attention", "active_system_deleted"].includes(row.status)
      ) {
        await client.query("ROLLBACK");
        return { outcome: "not_applicable" };
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
      await client.query(
        `UPDATE owner_purge_orders
         SET status = 'active_system_deleted',
             active_system_deleted_at = COALESCE(active_system_deleted_at, $2),
             backup_retention_until = $3,
             needs_attention_reason = NULL
         WHERE owner_purge_order_id = $1`,
        [input.ownerPurgeOrderId, input.now, backupRetentionUntil],
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
          WHERE command_type = 'owner_full_purge'
            AND subject_type = 'app_user'
            AND subject_id = $1
            AND expected_data_epoch = $2
        `,
        [row.user_id, row.data_epoch],
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
  }): Promise<void> {
    await this.pool.query<QueryResultRow>(
      `
        UPDATE owner_purge_orders
        SET status = 'needs_attention',
            needs_attention_at = $2,
            needs_attention_reason = $3
        WHERE owner_purge_order_id = $1
          AND status <> 'retention_pending'
      `,
      [input.ownerPurgeOrderId, input.now, input.reason],
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

  public async reapplyMarker(input: {
    userId: UserId;
    dataEpoch: number;
    now: Date;
  }): Promise<Readonly<{ outcome: "reapplied" }>> {
    const client = await this.pool.connect();
    let orderId: string;
    try {
      await client.query("BEGIN");
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

      const existing = await client.query<{ owner_purge_order_id: string }>(
        `SELECT owner_purge_order_id
         FROM owner_purge_orders
         WHERE user_id = $1 AND data_epoch = $2
         ORDER BY requested_at DESC LIMIT 1`,
        [input.userId, input.dataEpoch],
      );
      orderId = existing.rows[0]?.owner_purge_order_id ?? crypto.randomUUID();
      if (!existing.rows[0]) {
        const fromDataEpoch = Math.max(1, Number(ownerRow.data_epoch));
        await client.query(
          `INSERT INTO owner_purge_orders (
             owner_purge_order_id, user_id, from_data_epoch, data_epoch,
             status, confirmation, policy_version, requested_at, last_attempt_at
           ) VALUES ($1, $2, $3, $4, 'requested', 'PURGE',
             'recovery-marker-reapply:v1', $5, $5)`,
          [orderId, input.userId, fromDataEpoch, input.dataEpoch, input.now],
        );
      }
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
        ownerPurgeOrderId: orderId!,
        providerRetentionUntil: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
        now,
      });
      await this.transitionToVerifying({ ownerPurgeOrderId: orderId!, now });
      await this.transitionToActiveSystemDeleted({
        backupRetentionUntil: null,
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
