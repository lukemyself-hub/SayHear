import {
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
  PURGE_WORKFLOW_SUBJECT_MANIFEST,
  normalizePurgeSurfaceConstraintDefinition,
  PurgeSurfaceRegistryError,
  validatePurgeSurfaceInventory,
  type PurgeSurfaceEntry,
  type PurgeSurfaceExternalIntegration,
  type PurgeSurfaceOwnerResolution,
  type PurgeSurfaceRegistrySnapshot,
} from "@sayhear/application/purge-surface-registry";
import { PurgeVerificationError } from "@sayhear/application/owner-purge";
import type { PoolClient } from "pg";

export type PostgresPurgeSurfaceContext = Readonly<{
  ownerPurgeOrderId: string;
  userId: string;
  now: Date;
}>;

/**
 * This is an independent runtime manifest. It must be updated alongside the
 * application registry when a provider-egress integration is added or
 * removed; the runtime inventory gate compares the two before a purge opens.
 */
const RUNTIME_EXTERNAL_INTEGRATION_MANIFEST_VERSION =
  PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION;
const RUNTIME_EXTERNAL_INTEGRATION_IDS = [
  "provider-egress.responses-api",
] as const;

const PROVIDER_RECEIPT_DISPOSITIONS = [
  "retention_pending",
  "verified_deleted",
  "policy_expired",
  "not_applicable",
  "unknown",
] as const;

type ProviderReceiptInput = Readonly<{
  destination: string;
  destinationDisposition: string;
  providerRetentionUntil: Date | null;
}>;

export const OWNER_WORKFLOW_COMMAND_SCOPE = `(
  (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.dailySession}'
    AND command.subject_id IN (
      SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.conversationEventRevision}'
    AND command.subject_id IN (
      SELECT conversation_event_revision_id
      FROM conversation_event_revisions WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.memoryClaim}'
    AND command.subject_id IN (
      SELECT memory_claim_id FROM memory_claims WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.entity}'
    AND command.subject_id IN (
      SELECT entity_id FROM entities WHERE user_id = $1
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.appUser}'
    AND command.subject_id = $1
  )
)`;

/**
 * Verification deliberately uses a separately authored subject walk. The
 * clear scope above is an owner-resolution input; reusing it here would let a
 * defect in the deletion predicate certify its own result.
 */
const VERIFICATION_OWNER_WORKFLOW_COMMAND_SCOPE = `(
  (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.dailySession}'
    AND EXISTS (
      SELECT 1
      FROM daily_sessions verification_daily_session
      WHERE verification_daily_session.user_id = $1
        AND verification_daily_session.daily_session_id = command.subject_id
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.conversationEventRevision}'
    AND EXISTS (
      SELECT 1
      FROM conversation_event_revisions verification_revision
      WHERE verification_revision.user_id = $1
        AND verification_revision.conversation_event_revision_id = command.subject_id
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.memoryClaim}'
    AND EXISTS (
      SELECT 1
      FROM memory_claims verification_claim
      WHERE verification_claim.user_id = $1
        AND verification_claim.memory_claim_id = command.subject_id
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.entity}'
    AND EXISTS (
      SELECT 1
      FROM entities verification_entity
      WHERE verification_entity.user_id = $1
        AND verification_entity.entity_id = command.subject_id
    )
  )
  OR (
    command.subject_type = '${PURGE_WORKFLOW_SUBJECT_MANIFEST.subjectTypes.appUser}'
    AND command.subject_id = $1
  )
)`;

const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function tableName(entry: PurgeSurfaceEntry): string {
  const table = entry.schemaObjects.find((object) => object.kind === "table")
    ?.name;
  if (!table || !IDENTIFIER.test(table)) {
    throw new PurgeSurfaceRegistryError(
      `invalid_table_identifier:${entry.surfaceId}`,
    );
  }
  return table;
}

function ownerPredicate(
  resolution: PurgeSurfaceOwnerResolution,
): string {
  switch (resolution.kind) {
    case "direct_user_id":
      return `${resolution.column} = $1`;
    case "daily_session_id":
      return `${resolution.column} IN (
        SELECT daily_session_id FROM daily_sessions WHERE user_id = $1
      )`;
    case "evidence_item_id":
      return `${resolution.column} IN (
        SELECT evidence_item_id FROM evidence_items WHERE user_id = $1
      )`;
    case "evidence_source_snapshot_id":
      return `${resolution.column} IN (
        SELECT evidence_source_snapshot_id
        FROM evidence_source_snapshots WHERE user_id = $1
      )`;
    case "journal_statement_id":
      return `${resolution.column} IN (
        SELECT journal_statement_id FROM journal_statements WHERE user_id = $1
      )`;
    case "journal_generation_command_id":
      return `${resolution.column} IN (
        SELECT generation_command_id
        FROM journal_generation_commands WHERE user_id = $1
      )`;
    case "generation_command_id":
      return `${resolution.column} IN (
        SELECT generation_command_id FROM generation_commands WHERE user_id = $1
      )`;
    case "rolling_summary_command_id":
      return `${resolution.column} IN (
        SELECT rolling_summary_command_id
        FROM rolling_summary_commands WHERE user_id = $1
      )`;
    case "dialogue_state_command_id":
      return `${resolution.column} IN (
        SELECT dialogue_state_command_id
        FROM dialogue_state_commands WHERE user_id = $1
      )`;
    case "conversation_action_execution_id":
      return `${resolution.column} IN (
        SELECT action_execution_id
        FROM conversation_action_executions WHERE user_id = $1
      )`;
    case "auth_session_token_hash":
      return `${resolution.column} IN (
        SELECT session_token_hash FROM auth_sessions WHERE user_id = $1
      )`;
    case "owner_purge_order_id":
      return `${resolution.column} IN (
        SELECT owner_purge_order_id FROM owner_purge_orders WHERE user_id = $1
      )`;
    case "owner_workflow_command":
    case "owner_outbox_event":
    case "ordinary_entity":
    case "ordinary_entity_version":
    case "owner_envelope":
      return "FALSE";
  }
}

function verificationPredicate(
  resolution: PurgeSurfaceOwnerResolution,
  tableAlias: string,
): string {
  switch (resolution.kind) {
    case "direct_user_id":
      return `${tableAlias}.user_id = $1`;
    case "daily_session_id":
      return `EXISTS (
        SELECT 1 FROM daily_sessions verification_daily_session
        WHERE verification_daily_session.user_id = $1
          AND verification_daily_session.daily_session_id = ${tableAlias}.${resolution.column}
      )`;
    case "evidence_item_id":
      return `EXISTS (
        SELECT 1 FROM evidence_items verification_evidence_item
        WHERE verification_evidence_item.user_id = $1
          AND verification_evidence_item.evidence_item_id = ${tableAlias}.${resolution.column}
      )`;
    case "evidence_source_snapshot_id":
      return `EXISTS (
        SELECT 1 FROM evidence_source_snapshots verification_snapshot
        WHERE verification_snapshot.user_id = $1
          AND verification_snapshot.evidence_source_snapshot_id = ${tableAlias}.${resolution.column}
      )`;
    case "journal_statement_id":
      return `EXISTS (
        SELECT 1 FROM journal_statements verification_statement
        WHERE verification_statement.user_id = $1
          AND verification_statement.journal_statement_id = ${tableAlias}.${resolution.column}
      )`;
    case "journal_generation_command_id":
      return `EXISTS (
        SELECT 1 FROM journal_generation_commands verification_command
        WHERE verification_command.user_id = $1
          AND verification_command.generation_command_id = ${tableAlias}.${resolution.column}
      )`;
    case "generation_command_id":
      return `EXISTS (
        SELECT 1 FROM generation_commands verification_command
        WHERE verification_command.user_id = $1
          AND verification_command.generation_command_id = ${tableAlias}.${resolution.column}
      )`;
    case "rolling_summary_command_id":
      return `EXISTS (
        SELECT 1 FROM rolling_summary_commands verification_command
        WHERE verification_command.user_id = $1
          AND verification_command.rolling_summary_command_id = ${tableAlias}.${resolution.column}
      )`;
    case "dialogue_state_command_id":
      return `EXISTS (
        SELECT 1 FROM dialogue_state_commands verification_command
        WHERE verification_command.user_id = $1
          AND verification_command.dialogue_state_command_id = ${tableAlias}.${resolution.column}
      )`;
    case "conversation_action_execution_id":
      return `EXISTS (
        SELECT 1 FROM conversation_action_executions verification_execution
        WHERE verification_execution.user_id = $1
          AND verification_execution.action_execution_id = ${tableAlias}.${resolution.column}
      )`;
    case "auth_session_token_hash":
      return `EXISTS (
        SELECT 1 FROM auth_sessions verification_session
        WHERE verification_session.user_id = $1
          AND verification_session.session_token_hash = ${tableAlias}.${resolution.column}
      )`;
    case "owner_purge_order_id":
      return `EXISTS (
        SELECT 1 FROM owner_purge_orders verification_order
        WHERE verification_order.user_id = $1
          AND verification_order.owner_purge_order_id = ${tableAlias}.${resolution.column}
      )`;
    case "owner_workflow_command":
    case "owner_outbox_event":
    case "ordinary_entity":
    case "ordinary_entity_version":
    case "owner_envelope":
      return "FALSE";
  }
}

export function assertPurgeSurfaceAdapterCoverage(
  registry: PurgeSurfaceRegistrySnapshot,
): void {
  const clearHandlers = new Set([
    "delete_owner_rows",
    "delete_owner_workflow_commands",
    "delete_owner_outbox_events",
    "tombstone_conversation_revisions",
    "purge_memory_claims",
    "purge_memory_claim_versions",
    "purge_memory_claim_version_qualifiers",
    "purge_ordinary_entities",
    "purge_ordinary_entity_versions",
    "purge_bio_versions",
    "purge_bios",
    "purge_episode_versions",
    "purge_episodes",
    "purge_narrative_validator_requests",
    "purge_narrative_validator_results",
    "redact_sensitive_access_audits",
    "capture_owner_purge_operational_metadata",
    "record_provider_retention",
    "retain_owner_envelope",
    "retain_governance",
  ]);
  const verifyHandlers = new Set([
    "verify_owner_rows_empty",
    "verify_owner_workflow_commands_empty",
    "verify_owner_outbox_events_empty",
    "verify_conversation_revisions_purged",
    "verify_memory_claims_purged",
    "verify_episode_versions_purged",
    "verify_episodes_purged",
    "verify_narrative_validator_requests_purged",
    "verify_narrative_validator_results_purged",
    "verify_memory_claim_versions_purged",
    "verify_memory_claim_version_qualifiers_purged",
    "verify_ordinary_entities_purged",
    "verify_ordinary_entity_versions_purged",
    "verify_sensitive_access_audits_redacted",
    "verify_owner_purge_operational_metadata",
    "verify_provider_retention_receipt",
    "verify_owner_envelope",
    "verify_owner_purge_order",
    "verify_owner_purge_receipts",
  ]);
  for (const surface of registry.surfaces) {
    if (!clearHandlers.has(surface.clearHandler)) {
      throw new PurgeSurfaceRegistryError(
        `missing_clear_adapter:${surface.surfaceId}:${surface.clearHandler}`,
      );
    }
    if (!verifyHandlers.has(surface.verifyHandler)) {
      throw new PurgeSurfaceRegistryError(
        `missing_verify_adapter:${surface.surfaceId}:${surface.verifyHandler}`,
      );
    }
  }
  if (
    registry.externalIntegrationManifestVersion !==
    RUNTIME_EXTERNAL_INTEGRATION_MANIFEST_VERSION
  ) {
    throw new PurgeSurfaceRegistryError(
      "external_integration_manifest_version_mismatch",
    );
  }
  const registeredExternalIntegrations = new Set(
    registry.externalIntegrations.map(
      (integration) => integration.integrationId,
    ),
  );
  const runtimeExternalIntegrations = new Set<string>(
    RUNTIME_EXTERNAL_INTEGRATION_IDS,
  );
  if (
    registeredExternalIntegrations.size !== runtimeExternalIntegrations.size ||
    [...registeredExternalIntegrations].some(
      (integration) => !runtimeExternalIntegrations.has(integration),
    )
  ) {
    throw new PurgeSurfaceRegistryError(
      "external_integration_runtime_manifest_mismatch",
    );
  }
  for (const integration of registry.externalIntegrations) {
    if (
      integration.clearHandler !== "record_provider_retention" ||
      integration.verifyHandler !== "verify_provider_retention_receipt" ||
      integration.receiptDestination !== "provider:role"
    ) {
      throw new PurgeSurfaceRegistryError(
        `unsupported_external_integration_adapter:${integration.integrationId}`,
      );
    }
  }
  for (const surface of registry.surfaces) {
    if (surface.restoreReapplyHandler !== "owner-purge-reapply:v1") {
      throw new PurgeSurfaceRegistryError(
        `unsupported_restore_adapter:${surface.surfaceId}:${surface.restoreReapplyHandler}`,
      );
    }
    const supportedReceiptDestination =
      surface.receiptDestination === "business_database" ||
      surface.receiptDestination === "purge_marker_store" ||
      (surface.receiptDestination.startsWith("provider:") &&
        surface.receiptDestination.length > "provider:".length);
    if (!supportedReceiptDestination) {
      throw new PurgeSurfaceRegistryError(
        `unsupported_receipt_destination:${surface.surfaceId}:${surface.receiptDestination}`,
      );
    }
    if (
      surface.readDeadlinePolicy.kind === "active_system_deleted_plus_days" &&
      ![
        "redact_sensitive_access_audits",
        "capture_owner_purge_operational_metadata",
      ].includes(surface.clearHandler)
    ) {
      throw new PurgeSurfaceRegistryError(
        `missing_deadline_adapter:${surface.surfaceId}`,
      );
    }
  }
}

const OWNER_ROOT_TABLES = new Set([
  "app_users",
  "workflow_commands",
  "outbox_events",
  "owner_purge_orders",
  "owner_purge_receipts",
]);

/**
 * Inspect the live PostgreSQL catalogs before any destructive operation. The
 * migration script is the release gate; this runtime gate catches a schema or
 * integration drift that was introduced after the application was built.
 */
export async function assertPurgeSurfaceDatabaseInventory(
  client: PoolClient,
  registry: PurgeSurfaceRegistrySnapshot,
): Promise<void> {
  assertPurgeSurfaceAdapterCoverage(registry);

  const tables = await client.query<{
    table_name: string;
    has_user_id: boolean;
  }>(
    `SELECT relation.relname AS table_name,
            EXISTS (
              SELECT 1 FROM pg_attribute column_def
              WHERE column_def.attrelid = relation.oid
                AND column_def.attname = 'user_id'
                AND column_def.attnum > 0
                AND NOT column_def.attisdropped
            ) AS has_user_id
     FROM pg_class relation
     INNER JOIN pg_namespace namespace
       ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND relation.relkind IN ('r', 'p')
       AND relation.relname <> 'schema_migrations'`,
  );
  const foreignKeys = await client.query<{
    child_table: string;
    parent_table: string;
    definition: string;
  }>(
    `SELECT child.relname AS child_table,
            parent.relname AS parent_table,
            pg_get_constraintdef(constraint_def.oid) AS definition
     FROM pg_constraint constraint_def
     INNER JOIN pg_class child ON child.oid = constraint_def.conrelid
     INNER JOIN pg_class parent ON parent.oid = constraint_def.confrelid
     INNER JOIN pg_namespace child_namespace
       ON child_namespace.oid = child.relnamespace
     INNER JOIN pg_namespace parent_namespace
       ON parent_namespace.oid = parent.relnamespace
     WHERE constraint_def.contype = 'f'
       AND child_namespace.nspname = current_schema()
      AND parent_namespace.nspname = current_schema()`,
  );
  const columns = await client.query<{
    table_name: string;
    column_name: string;
  }>(
    `SELECT relation.relname AS table_name,
            column_def.attname AS column_name
     FROM pg_class relation
     INNER JOIN pg_namespace namespace
       ON namespace.oid = relation.relnamespace
     INNER JOIN pg_attribute column_def
       ON column_def.attrelid = relation.oid
     WHERE namespace.nspname = current_schema()
       AND relation.relkind IN ('r', 'p')
       AND relation.relname <> 'schema_migrations'
       AND column_def.attnum > 0
       AND NOT column_def.attisdropped`,
  );

  const ownerTables = new Set(OWNER_ROOT_TABLES);
  for (const table of tables.rows) {
    if (table.has_user_id) {
      ownerTables.add(table.table_name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const foreignKey of foreignKeys.rows) {
      if (
        ownerTables.has(foreignKey.parent_table) &&
        !ownerTables.has(foreignKey.child_table)
      ) {
        ownerTables.add(foreignKey.child_table);
        changed = true;
      }
    }
  }

  const indexes = await client.query<{
    name: string;
    table: string;
    definition: string;
  }>(
    `SELECT index_relation.relname AS name,
            table_relation.relname AS table,
            pg_get_indexdef(index_relation.oid) AS definition
     FROM pg_index index_def
     INNER JOIN pg_class table_relation
       ON table_relation.oid = index_def.indrelid
     INNER JOIN pg_class index_relation
       ON index_relation.oid = index_def.indexrelid
     INNER JOIN pg_namespace namespace
       ON namespace.oid = table_relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_relation.relkind IN ('r', 'p')
       AND index_relation.relkind = 'i'
       AND NOT EXISTS (
         SELECT 1 FROM pg_depend dependency
         WHERE dependency.classid = 'pg_class'::regclass
           AND dependency.objid = index_relation.oid
           AND dependency.refclassid = 'pg_constraint'::regclass
           AND dependency.deptype = 'i'
      )`,
  );
  const constraints = await client.query<{
    table_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `SELECT relation.relname AS table_name,
            constraint_def.contype AS constraint_type,
            pg_get_constraintdef(constraint_def.oid) AS definition
     FROM pg_constraint constraint_def
     INNER JOIN pg_class relation ON relation.oid = constraint_def.conrelid
     INNER JOIN pg_namespace namespace
       ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = current_schema()
       AND relation.relkind IN ('r', 'p')
       AND constraint_def.contype IN ('p', 'u', 'c', 'x')`,
  );
  const inventory = {
    columns: columns.rows
      .filter((column) => ownerTables.has(column.table_name))
      .map((column) => `${column.table_name}.${column.column_name}`)
      .sort(),
    tables: [...ownerTables].sort(),
    foreignKeys: foreignKeys.rows
      .map(
        (foreignKey) =>
          `${foreignKey.child_table}|${foreignKey.definition.replace(/\s+/g, " ").trim().toUpperCase()}`,
      )
      .sort(),
    indexes: indexes.rows
      .filter((index) => ownerTables.has(index.table))
      .sort((left, right) => left.name.localeCompare(right.name)),
    constraints: constraints.rows
      .filter((constraint) => ownerTables.has(constraint.table_name))
      .map(
        (constraint) =>
          `${constraint.table_name}|${normalizePurgeSurfaceConstraintDefinition(
            constraint.definition,
          )}`,
      )
      .sort(),
    externalIntegrationManifestVersion:
      RUNTIME_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
    externalIntegrations: [...RUNTIME_EXTERNAL_INTEGRATION_IDS],
  } as const;
  const result = validatePurgeSurfaceInventory(inventory, registry);
  if (!result.ok) {
    const details = [
      ...result.missingTables.map((table) => `missing_table:${table}`),
      ...result.missingIndexes.map((index) => `missing_index:${index}`),
      ...result.missingExternalIntegrations.map(
        (integration) => `missing_external_integration:${integration}`,
      ),
      ...result.registryExternalIntegrationsMissingFromInventory.map(
        (integration) => `registered_external_missing:${integration}`,
      ),
      ...result.indexTableMismatches.map(
        (mismatch) =>
          `index_table_mismatch:${mismatch.name}:${mismatch.registeredTable}:${mismatch.inventoryTable}`,
      ),
      ...result.registryObjectsMissingFromSchema.map(
        (object) => `registry_object_missing:${object}`,
      ),
      ...result.registryColumnsMissingFromSchema.map(
        (column) => `registry_column_missing:${column}`,
      ),
      ...(result.foreignKeyManifestMismatch
        ? [
            `foreign_key_manifest_mismatch:${result.foreignKeyManifestMismatch.actual}:${result.foreignKeyManifestMismatch.expected}`,
          ]
        : []),
      ...(result.externalIntegrationManifestVersionMismatch
        ? [
            `external_integration_manifest_version_mismatch:${result.externalIntegrationManifestVersionMismatch.actual}:${result.externalIntegrationManifestVersionMismatch.expected}`,
          ]
        : []),
      ...(result.columnManifestMismatch
        ? [
            `column_manifest_mismatch:${result.columnManifestMismatch.actual}:${result.columnManifestMismatch.expected}`,
          ]
        : []),
      ...(result.constraintManifestMismatch
        ? [
            `constraint_manifest_mismatch:${result.constraintManifestMismatch.actual}:${result.constraintManifestMismatch.expected}`,
          ]
        : []),
      ...(result.indexManifestMismatch
        ? [
            `index_manifest_mismatch:${result.indexManifestMismatch.actual}:${result.indexManifestMismatch.expected}`,
          ]
        : []),
    ];
    throw new PurgeSurfaceRegistryError(
      `database_inventory_mismatch:${details.join(",")}`,
    );
  }
}

const OPERATIONAL_METADATA_INSERT_COLUMNS = `
  owner_purge_operational_metadata_id, owner_purge_order_id, user_id,
  surface_id, operation_type, status, policy_version, provider, role,
  error_category, attempt_count, recorded_at
`;

async function captureOwnerPurgeOperationalMetadata(
  client: PoolClient,
  context: PostgresPurgeSurfaceContext,
): Promise<void> {
  const insert = async (select: string): Promise<void> => {
    await client.query(
      `INSERT INTO owner_purge_operational_metadata (
         ${OPERATIONAL_METADATA_INSERT_COLUMNS}
       )
       ${select}
       ON CONFLICT (
         owner_purge_order_id, surface_id, operation_type, status,
         policy_version, provider, role, error_category, attempt_count,
         recorded_at
       ) DO NOTHING`,
      [context.userId, context.ownerPurgeOrderId],
    );
  };

  // These SELECTs deliberately project only the allowlisted operational
  // fields. In particular, no payload, domain object ID, request ID,
  // fingerprint, free-form reason or content-bearing JSON crosses the purge
  // boundary.
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'generation_commands',
      command.operation_type, command.status, command.product_policy_version,
      command.provider, command.operation_type, '', 0, command.created_at
    FROM generation_commands command
    WHERE command.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'model_run_attempts',
      attempt.operation_type, attempt.status, attempt.prompt_version,
      attempt.provider, attempt.operation_type, COALESCE(attempt.error_category, ''),
      attempt.attempt_no, attempt.created_at
    FROM model_run_attempts attempt
    WHERE attempt.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'journal_generation_commands',
      'journal_generation', 'created', command.generation_policy_version,
      '', '', '', 0, command.created_at
    FROM journal_generation_commands command
    WHERE command.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'journal_model_run_attempts',
      'journal_model_run', attempt.status, attempt.role_policy_version,
      attempt.provider, attempt.role, '', 0, attempt.created_at
    FROM journal_model_run_attempts attempt
    INNER JOIN journal_generation_commands command
      ON command.generation_command_id = attempt.generation_command_id
    WHERE command.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'evidence_model_run_attempts',
      'evidence.extract', attempt.status, attempt.extraction_policy_version,
      attempt.provider, attempt.role, '', 0, attempt.created_at
    FROM evidence_model_run_attempts attempt
    INNER JOIN evidence_source_snapshots snapshot
      ON snapshot.evidence_source_snapshot_id = attempt.evidence_source_snapshot_id
    WHERE snapshot.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'rolling_summary_commands',
      'rolling_summary', command.status, command.policy_version,
      '', 'summary.compress', '', 0, command.created_at
    FROM rolling_summary_commands command
    WHERE command.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'dialogue_state_commands',
      'dialogue_state', command.status, command.policy_version,
      '', 'dialogue.state', '', 0, command.created_at
    FROM dialogue_state_commands command
    WHERE command.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'fast_path_extraction_runs',
      'memory.extract', run.status, run.extraction_policy_version,
      '', 'memory.extract', '', 0,
      run.created_at
    FROM fast_path_extraction_runs run
    WHERE run.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'fast_path_extraction_runs',
      'entity.resolve', run.status, run.extraction_policy_version,
      '', 'entity.resolve', '', 0,
      run.created_at
    FROM fast_path_extraction_runs run
    WHERE run.user_id = $1 AND run.entity_resolve_config_version IS NOT NULL
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'memory_consolidation_runs',
      'memory.consolidate', run.status, run.policy_version,
      '', 'memory.consolidate', '', 0,
      run.created_at
    FROM memory_consolidation_runs run
    WHERE run.user_id = $1 AND run.model_attempt_id IS NOT NULL
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'workflow_commands',
      command.command_type, command.status, command.policy_version,
      '', '', '', 0, command.created_at
    FROM workflow_commands command
    WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'outbox_events',
      event.event_type, event.status, '', '', '', '', event.attempt_count,
      event.created_at
    FROM outbox_events event
    INNER JOIN workflow_commands command
      ON command.workflow_command_id = event.workflow_command_id
    WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'provider_egress_dispositions',
      disposition.role, disposition.status,
      disposition.provider_policy_version, disposition.provider,
      disposition.role, COALESCE(disposition.error_category, ''), 0,
      disposition.checked_at
    FROM provider_egress_dispositions disposition
    WHERE disposition.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'daily_session_date_outcomes',
      'journal_eligibility', outcome.outcome,
      outcome.eligibility_policy_version, '', '', '', 0, outcome.computed_at
    FROM daily_session_date_outcomes outcome
    WHERE outcome.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'continuous_exchange_inactivity_evaluations',
      'continuous_exchange_inactivity', COALESCE(evaluation.outcome, 'pending'),
      evaluation.policy_version, '', '', '', 0, evaluation.created_at
    FROM continuous_exchange_inactivity_evaluations evaluation
    WHERE evaluation.user_id = $1
  `);
  await insert(`
    SELECT gen_random_uuid(), $2, $1, 'journal_workflow_outcomes',
      'journal_workflow', outcome.outcome, '', '', '', '', 0, outcome.created_at
    FROM journal_workflow_outcomes outcome
    WHERE outcome.user_id = $1
  `);
}

const PROVIDER_METADATA_SURFACE_IDS = [
  "generation_commands",
  "model_run_attempts",
  "evidence_model_run_attempts",
  "journal_model_run_attempts",
  "rolling_summary_commands",
  "dialogue_state_commands",
  "fast_path_extraction_runs",
  "memory_consolidation_runs",
] as const;

const PROVIDER_METADATA_SURFACE_SQL = PROVIDER_METADATA_SURFACE_IDS.map(
  (surfaceId) => `'${surfaceId}'`,
).join(", ");

type ProviderReceiptRow = Readonly<{
  destination: string;
  destination_disposition: string;
  provider_disposition: string | null;
  provider_retention_until: Date | null;
}>;

async function listExpectedProviderRoles(
  client: PoolClient,
  context: PostgresPurgeSurfaceContext,
): Promise<readonly string[]> {
  const result = await client.query<{ role: string }>(
    `SELECT DISTINCT role
     FROM owner_purge_operational_metadata
     WHERE owner_purge_order_id = $1
       AND user_id = $2
       AND surface_id IN (${PROVIDER_METADATA_SURFACE_SQL})
       AND role <> ''
     ORDER BY role`,
    [context.ownerPurgeOrderId, context.userId],
  );
  return [...new Set(result.rows.map((row) => row.role))];
}

function assertProviderReceiptInput(receipt: ProviderReceiptInput): void {
  const isProviderReceipt =
    receipt.destination.startsWith("provider:") &&
    receipt.destination.length > "provider:".length;
  if (!isProviderReceipt) {
    throw new PurgeVerificationError("provider_receipt_destination_invalid");
  }
  if (
    !PROVIDER_RECEIPT_DISPOSITIONS.includes(
      receipt.destinationDisposition as never,
    ) ||
    receipt.destinationDisposition === "unknown"
  ) {
    throw new PurgeVerificationError("provider_receipt_disposition_invalid");
  }
  if (
    receipt.providerRetentionUntil !== null &&
    Number.isNaN(receipt.providerRetentionUntil.getTime())
  ) {
    throw new PurgeVerificationError("provider_retention_horizon_invalid");
  }
  if (
    ["retention_pending", "policy_expired"].includes(
      receipt.destinationDisposition,
    ) &&
    receipt.providerRetentionUntil === null
  ) {
    throw new PurgeVerificationError("provider_retention_horizon_missing");
  }
}

async function readProviderReceipts(
  client: PoolClient,
  ownerPurgeOrderId: string,
): Promise<readonly ProviderReceiptRow[]> {
  const result = await client.query<ProviderReceiptRow>(
    `SELECT destination, destination_disposition, provider_disposition,
            provider_retention_until
     FROM owner_purge_receipts
     WHERE owner_purge_order_id = $1
       AND destination LIKE 'provider:%'
     ORDER BY destination`,
    [ownerPurgeOrderId],
  );
  return result.rows;
}

function assertProviderReceiptRow(receipt: ProviderReceiptRow): void {
  if (
    !PROVIDER_RECEIPT_DISPOSITIONS.includes(
      receipt.destination_disposition as never,
    ) ||
    receipt.destination_disposition === "unknown" ||
    receipt.provider_disposition === null ||
    !PROVIDER_RECEIPT_DISPOSITIONS.includes(
      receipt.provider_disposition as never,
    ) ||
    receipt.provider_disposition === "unknown" ||
    receipt.provider_disposition !== receipt.destination_disposition
  ) {
    throw new PurgeVerificationError("provider_receipt_invalid");
  }
  if (
    ["retention_pending", "policy_expired"].includes(
      receipt.destination_disposition,
    ) &&
    receipt.provider_retention_until === null
  ) {
    throw new PurgeVerificationError("provider_retention_horizon_missing");
  }
}

/**
 * Clear the registered external integration without making a provider API
 * call. The current Responses API contract has no deletion endpoint, so the
 * durable action is a content-free retention receipt. Recovery may supply the
 * marker's exact provider receipts; an explicit empty list must remain empty
 * so a missing marker destination fails closed during independent verification.
 */
export async function clearPurgeSurfaceIntegration(
  client: PoolClient,
  integration: PurgeSurfaceExternalIntegration,
  context: PostgresPurgeSurfaceContext,
  input: Readonly<{
    providerRetentionUntil?: Date;
    providerReceipts?: readonly ProviderReceiptInput[];
  }>,
): Promise<readonly string[]> {
  if (
    integration.integrationId !== "provider-egress.responses-api" ||
    integration.clearHandler !== "record_provider_retention"
  ) {
    throw new PurgeSurfaceRegistryError(
      `missing_external_clear_adapter:${integration.integrationId}`,
    );
  }

  const receipts =
    input.providerReceipts !== undefined
      ? [...input.providerReceipts]
      : (await listExpectedProviderRoles(client, context)).map((role) => ({
          destination: `provider:${role}`,
          destinationDisposition: "retention_pending",
          providerRetentionUntil: input.providerRetentionUntil ?? null,
        }));
  const byDestination = new Map<string, ProviderReceiptInput>();
  for (const receipt of receipts) {
    assertProviderReceiptInput(receipt);
    const existing = byDestination.get(receipt.destination);
    if (
      existing &&
      (existing.destinationDisposition !== receipt.destinationDisposition ||
        existing.providerRetentionUntil?.getTime() !==
          receipt.providerRetentionUntil?.getTime())
    ) {
      throw new PurgeVerificationError("provider_receipt_duplicate_conflict");
    }
    byDestination.set(receipt.destination, receipt);
  }
  if (
    input.providerReceipts === undefined &&
    byDestination.size > 0 &&
    input.providerRetentionUntil === undefined
  ) {
    throw new PurgeVerificationError("provider_retention_horizon_missing");
  }
  for (const receipt of byDestination.values()) {
    await client.query(
      `INSERT INTO owner_purge_receipts (
         owner_purge_receipt_id, owner_purge_order_id, destination,
         destination_disposition, provider_disposition,
         provider_retention_until, recorded_at
       )
       VALUES (
         gen_random_uuid(), $1, $2, $3, $3, $4, $5
       )
       ON CONFLICT (owner_purge_order_id, destination) DO NOTHING`,
      [
        context.ownerPurgeOrderId,
        receipt.destination,
        receipt.destinationDisposition,
        receipt.providerRetentionUntil,
        context.now,
      ],
    );
  }
  return [...byDestination.keys()]
    .map((destination) => destination.slice("provider:".length))
    .sort();
}

/** Independently verify the external provider receipt set against captured roles. */
export async function verifyPurgeSurfaceIntegration(
  client: PoolClient,
  integration: PurgeSurfaceExternalIntegration,
  context: PostgresPurgeSurfaceContext,
): Promise<void> {
  if (
    integration.integrationId !== "provider-egress.responses-api" ||
    integration.verifyHandler !== "verify_provider_retention_receipt" ||
    integration.receiptDestination !== "provider:role"
  ) {
    throw new PurgeSurfaceRegistryError(
      `missing_external_verify_adapter:${integration.integrationId}`,
    );
  }
  const expectedRoles = await listExpectedProviderRoles(client, context);
  const receipts = await readProviderReceipts(
    client,
    context.ownerPurgeOrderId,
  );
  const byDestination = new Map(receipts.map((receipt) => [receipt.destination, receipt]));
  const expectedDestinations = new Set(
    expectedRoles.map((role) => `provider:${role}`),
  );
  for (const receipt of receipts) {
    if (!expectedDestinations.has(receipt.destination)) {
      throw new PurgeVerificationError(
        `provider_receipt_unexpected:${receipt.destination}`,
      );
    }
    assertProviderReceiptRow(receipt);
  }
  for (const role of expectedRoles) {
    const receipt = byDestination.get(`provider:${role}`);
    if (!receipt) {
      throw new PurgeVerificationError(`provider_receipt_missing:${role}`);
    }
    assertProviderReceiptRow(receipt);
  }
}

export async function clearPurgeSurface(
  client: PoolClient,
  surface: PurgeSurfaceEntry,
  context: PostgresPurgeSurfaceContext,
): Promise<void> {
  const table = tableName(surface);
  switch (surface.clearHandler) {
    case "retain_owner_envelope":
    case "retain_governance":
      return;
    case "tombstone_conversation_revisions":
      await client.query(
        `UPDATE ${table}
         SET content_purged_at = $2, canonical_text = ''
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, context.now],
      );
      return;
    case "purge_memory_claims":
      await client.query(
        `UPDATE ${table}
         SET canonical_key = NULL,
             subject_entity_id = NULL,
             object_entity_id = NULL,
             predicate_id = NULL,
             scope_key = NULL,
             current_version_id = NULL,
             deleted_at = COALESCE(deleted_at, $2),
             content_purged_at = COALESCE(content_purged_at, $2)
         WHERE user_id = $1`,
        [context.userId, context.now],
      );
      return;
    case "purge_memory_claim_versions":
      await client.query(
        `UPDATE ${table}
         SET content_purged_at = COALESCE(content_purged_at, $2),
             typed_value = NULL,
             temporal_status = NULL,
             valid_from = NULL,
             valid_from_precision = NULL,
             valid_to = NULL,
             valid_to_precision = NULL,
             subject_entity_version_id = NULL,
             object_entity_version_id = NULL
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, context.now],
      );
      return;
    case "purge_memory_claim_version_qualifiers":
      await client.query(
        `UPDATE ${table}
         SET content_purged_at = $2, typed_value = NULL
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, context.now],
      );
      return;
    case "purge_ordinary_entities":
      await client.query(
        `UPDATE ${table} entity
         SET current_version_id = NULL,
             deleted_at = COALESCE(deleted_at, $2)
         WHERE entity.user_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = entity.entity_id
           )`,
        [context.userId, context.now],
      );
      return;
    case "purge_ordinary_entity_versions":
      await client.query(
        `UPDATE ${table} version
         SET content_purged_at = $2
         WHERE version.user_id = $1
           AND version.content_purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = version.entity_id
           )`,
        [context.userId, context.now],
      );
      return;
    case "purge_bio_versions":
      // The current Bio pointer is a composite foreign key into the version
      // row. Clear it before deleting the owner's version history so the
      // aggregate can be removed without leaving a private pointer behind.
      await client.query(
        `UPDATE bios
         SET current_version_id = NULL
         WHERE user_id = $1`,
        [context.userId],
      );
      await client.query(
        `DELETE FROM ${table}
         WHERE user_id = $1`,
        [context.userId],
      );
      return;
    case "purge_bios":
      await client.query(
        `DELETE FROM ${table}
         WHERE user_id = $1`,
        [context.userId],
      );
      return;
    case "purge_episode_versions":
      // Episode version history keeps only a content-free lineage envelope:
      // the typed content and label transition to NULL together with
      // content_purged_at; identity, revisions and lineage stay frozen.
      await client.query(
        `UPDATE episode_versions
         SET label = NULL, content = NULL, content_purged_at = $2
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, new Date()],
      );
      return;
    case "purge_episodes":
      await client.query(
        `UPDATE episode_versions
         SET label = NULL, content = NULL, content_purged_at = $2
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, new Date()],
      );
      await client.query(
        `UPDATE episodes SET current_version_id = NULL, deleted_at = $2
         WHERE user_id = $1`,
        [context.userId, new Date()],
      );
      return;
    case "purge_narrative_validator_requests":
      // Validation content keeps only a content-free lineage envelope: the
      // draft text and frozen manifests transition to NULL together with
      // content_purged_at; identity, draft_ref and the request fingerprint
      // stay frozen.
      await client.query(
        `UPDATE narrative_validator_requests
         SET draft_text = NULL, generator_manifest = NULL,
             source_manifest = NULL, planned_coverage = NULL,
             content_purged_at = $2
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, new Date()],
      );
      return;
    case "purge_narrative_validator_results":
      await client.query(
        `UPDATE narrative_validator_results
         SET blocking_findings = NULL, advisory_findings = NULL,
             coverage = NULL, content_purged_at = $2
         WHERE user_id = $1 AND content_purged_at IS NULL`,
        [context.userId, new Date()],
      );
      return;
    case "redact_sensitive_access_audits":
      await client.query(
        `UPDATE ${table}
         SET target_type = 'purged_owner', target_id = NULL
         WHERE user_id = $1`,
        [context.userId],
      );
      return;
    case "capture_owner_purge_operational_metadata":
      await captureOwnerPurgeOperationalMetadata(client, context);
      return;
    case "delete_owner_workflow_commands":
      await client.query(
        `DELETE FROM ${table} command
         WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
           AND command.command_type <> 'owner_full_purge'`,
        [context.userId],
      );
      return;
    case "delete_owner_outbox_events":
      await client.query(
        `DELETE FROM ${table} event
         WHERE event.workflow_command_id IN (
           SELECT workflow_command_id
           FROM workflow_commands command
           WHERE ${OWNER_WORKFLOW_COMMAND_SCOPE}
             AND command.command_type <> 'owner_full_purge'
         )`,
        [context.userId],
      );
      return;
    case "delete_owner_rows":
      await client.query(
        `DELETE FROM ${table} WHERE ${ownerPredicate(surface.ownerResolution)}`,
        [context.userId],
      );
      return;
    default:
      throw new PurgeSurfaceRegistryError(
        `missing_clear_adapter:${surface.surfaceId}:${surface.clearHandler}`,
      );
  }
}

async function countOwnedRows(
  client: PoolClient,
  surface: PurgeSurfaceEntry,
  context: PostgresPurgeSurfaceContext,
): Promise<number> {
  const table = tableName(surface);
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} surface
     WHERE ${verificationPredicate(surface.ownerResolution, "surface")}`,
    [context.userId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function assertEmpty(
  client: PoolClient,
  surface: PurgeSurfaceEntry,
  context: PostgresPurgeSurfaceContext,
): Promise<void> {
  const count = await countOwnedRows(client, surface, context);
  if (count > 0) {
    throw new PurgeVerificationError(`${surface.surfaceId}_not_empty`);
  }
}

export async function verifyPurgeSurface(
  client: PoolClient,
  surface: PurgeSurfaceEntry,
  context: PostgresPurgeSurfaceContext,
): Promise<void> {
  const table = tableName(surface);
  switch (surface.verifyHandler) {
    case "verify_owner_rows_empty":
      await assertEmpty(client, surface, context);
      return;
    case "verify_owner_workflow_commands_empty": {
      const result = await client.query<{ count: string }>(
         `SELECT count(*)::text AS count
         FROM ${table} command
         WHERE ${VERIFICATION_OWNER_WORKFLOW_COMMAND_SCOPE}
           AND command.command_type <> 'owner_full_purge'`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("workflow_commands_not_cleared");
      }
      return;
    }
    case "verify_owner_outbox_events_empty": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${table} event
         WHERE event.workflow_command_id IN (
           SELECT workflow_command_id
           FROM workflow_commands command
           WHERE ${VERIFICATION_OWNER_WORKFLOW_COMMAND_SCOPE}
             AND command.command_type <> 'owner_full_purge'
         )`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("outbox_events_not_cleared");
      }
      return;
    }
    case "verify_conversation_revisions_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (content_purged_at IS NULL OR canonical_text <> '')`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("conversation_revisions_not_purged");
      }
      return;
    }
    case "verify_episode_versions_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (label IS NOT NULL
             OR content IS NOT NULL
             OR content_purged_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("episode_versions_not_purged");
      }
      return;
    }
    case "verify_episodes_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (episode_kind_id IS NOT NULL
             OR current_version_id IS NOT NULL
             OR deleted_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("episodes_not_purged");
      }
      return;
    }
    case "verify_narrative_validator_requests_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (draft_text IS NOT NULL
             OR generator_manifest IS NOT NULL
             OR source_manifest IS NOT NULL
             OR planned_coverage IS NOT NULL
             OR content_purged_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError(
          "narrative_validator_requests_not_purged",
        );
      }
      return;
    }
    case "verify_narrative_validator_results_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (blocking_findings IS NOT NULL
             OR advisory_findings IS NOT NULL
             OR coverage IS NOT NULL
             OR content_purged_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError(
          "narrative_validator_results_not_purged",
        );
      }
      return;
    }
    case "verify_memory_claims_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (canonical_key IS NOT NULL
             OR subject_entity_id IS NOT NULL
             OR object_entity_id IS NOT NULL
             OR predicate_id IS NOT NULL
             OR scope_key IS NOT NULL
             OR current_version_id IS NOT NULL
             OR deleted_at IS NULL
             OR content_purged_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("memory_claims_not_purged");
      }
      return;
    }
    case "verify_memory_claim_versions_purged":
    case "verify_memory_claim_version_qualifiers_purged": {
      if (surface.surfaceId === "memory_claim_versions") {
        const result = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table}
           WHERE user_id = $1
             AND (content_purged_at IS NULL
               OR typed_value IS NOT NULL
               OR temporal_status IS NOT NULL
               OR valid_from IS NOT NULL
               OR valid_from_precision IS NOT NULL
               OR valid_to IS NOT NULL
               OR valid_to_precision IS NOT NULL
               OR subject_entity_version_id IS NOT NULL
               OR object_entity_version_id IS NOT NULL)`,
          [context.userId],
        );
        if (Number(result.rows[0]?.count ?? 0) > 0) {
          throw new PurgeVerificationError("memory_claim_versions_not_purged");
        }
        return;
      }
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (content_purged_at IS NULL OR typed_value IS NOT NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError(`${surface.surfaceId}_not_purged`);
      }
      return;
    }
    case "verify_ordinary_entities_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} entity
         WHERE entity.user_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = entity.entity_id
           )
           AND (entity.current_version_id IS NOT NULL OR entity.deleted_at IS NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("ordinary_entities_not_purged");
      }
      return;
    }
    case "verify_ordinary_entity_versions_purged": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table} version
         WHERE version.user_id = $1
           AND version.content_purged_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM user_self_entities binding
             WHERE binding.user_id = $1 AND binding.entity_id = version.entity_id
           )`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("ordinary_entity_versions_not_purged");
      }
      return;
    }
    case "verify_sensitive_access_audits_redacted": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE user_id = $1
           AND (target_type <> 'purged_owner' OR target_id IS NOT NULL)`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError("sensitive_access_audits_not_redacted");
      }
      return;
    }
    case "verify_owner_purge_operational_metadata": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${table} metadata
         LEFT JOIN owner_purge_orders purge
           ON purge.owner_purge_order_id = metadata.owner_purge_order_id
         WHERE metadata.owner_purge_order_id = $1
           AND (
             metadata.user_id <> $2
             OR purge.user_id IS DISTINCT FROM $2
             OR metadata.surface_id NOT IN (
               'generation_commands', 'model_run_attempts',
               'workflow_commands', 'outbox_events',
               'provider_egress_dispositions',
               'daily_session_date_outcomes',
               'continuous_exchange_inactivity_evaluations',
               'journal_workflow_outcomes',
               'journal_generation_commands',
               'journal_model_run_attempts',
               'rolling_summary_commands', 'dialogue_state_commands',
               'evidence_model_run_attempts', 'fast_path_extraction_runs',
               'memory_consolidation_runs'
             )
           )`,
        [context.ownerPurgeOrderId, context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) > 0) {
        throw new PurgeVerificationError(
          "owner_purge_operational_metadata_invalid",
        );
      }
      return;
    }
    case "verify_owner_envelope": {
      // Self Entity provisioning is a separate lifecycle seam. A user may
      // legitimately have no binding yet; if present, its one-row primary-key
      // envelope is retained and the entity-specific verifier protects it.
      if (surface.surfaceId === "user_self_entities") {
        return;
      }
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM ${table}
         WHERE user_id = $1`,
        [context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) === 0) {
        throw new PurgeVerificationError(`${surface.surfaceId}_owner_missing`);
      }
      return;
    }
    case "verify_owner_purge_order": {
      const result = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM ${table}
         WHERE owner_purge_order_id = $1 AND user_id = $2`,
        [context.ownerPurgeOrderId, context.userId],
      );
      if (Number(result.rows[0]?.count ?? 0) !== 1) {
        throw new PurgeVerificationError("owner_purge_order_missing");
      }
      return;
    }
    case "verify_owner_purge_receipts": {
      const result = await client.query<{
        destination: string;
        destination_disposition: string;
        provider_disposition: string | null;
        provider_retention_until: Date | null;
      }>(
        `SELECT destination, destination_disposition, provider_disposition,
                provider_retention_until
         FROM ${table}
         WHERE owner_purge_order_id = $1`,
        [context.ownerPurgeOrderId],
      );
      const allowedDestinations = new Set([
        "business_database",
        "purge_marker_store",
      ]);
      for (const receipt of result.rows) {
        const isProviderReceipt =
          receipt.destination.startsWith("provider:") &&
          receipt.destination.length > "provider:".length;
        if (
          !(
            allowedDestinations.has(receipt.destination) ||
            isProviderReceipt
          ) ||
          !PROVIDER_RECEIPT_DISPOSITIONS.includes(
            receipt.destination_disposition as never,
          ) ||
          receipt.destination_disposition === "unknown" ||
          (receipt.provider_disposition !== null &&
            (!PROVIDER_RECEIPT_DISPOSITIONS.includes(
              receipt.provider_disposition as never,
            ) ||
              receipt.provider_disposition === "unknown")) ||
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
      return;
    }
    default:
      throw new PurgeSurfaceRegistryError(
        `missing_verify_adapter:${surface.surfaceId}:${surface.verifyHandler}`,
      );
  }
}

/**
 * Apply a registered read deadline using the original purge effective time.
 * The accessed_at fence prevents an old purge order from deleting audit rows
 * created after the owner was revived for a later epoch.
 */
export async function sweepExpiredPurgeSurface(
  client: PoolClient,
  surface: PurgeSurfaceEntry,
  now: Date,
): Promise<number> {
  if (surface.readDeadlinePolicy.kind === "none") {
    return 0;
  }
  const table = tableName(surface);
  if (surface.clearHandler === "capture_owner_purge_operational_metadata") {
    const result = await client.query(
      `DELETE FROM ${table} metadata
       USING owner_purge_orders purge
       WHERE metadata.owner_purge_order_id = purge.owner_purge_order_id
         AND metadata.user_id = purge.user_id
         AND purge.active_system_deleted_at IS NOT NULL
         AND purge.active_system_deleted_at
           + ($2 * interval '1 day') <= $1
       RETURNING metadata.owner_purge_operational_metadata_id`,
      [now, surface.readDeadlinePolicy.days],
    );
    return result.rowCount ?? 0;
  }
  if (surface.clearHandler !== "redact_sensitive_access_audits") {
    throw new PurgeSurfaceRegistryError(
      `missing_deadline_adapter:${surface.surfaceId}`,
    );
  }
  const result = await client.query(
    `DELETE FROM ${table} audit
     USING owner_purge_orders purge
     WHERE audit.user_id = purge.user_id
       AND purge.active_system_deleted_at IS NOT NULL
       AND audit.accessed_at <= purge.active_system_deleted_at
       AND purge.active_system_deleted_at
         + ($2 * interval '1 day') <= $1
     RETURNING audit.sensitive_access_audit_id`,
    [now, surface.readDeadlinePolicy.days],
  );
  return result.rowCount ?? 0;
}
