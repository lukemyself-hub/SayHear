/**
 * Closed Full Purge Surface Registry (Issue #194, SPEC #193 §11.3,
 * ADR-0131).
 *
 * The registry is executable policy, not documentation. Every owner-scoped
 * schema object has one entry with a clear handler, an independent verifier,
 * a receipt destination, a read-deadline policy, and a recovery reapply
 * handler. The data package owns the PostgreSQL adapters for these handler
 * identities; the application package owns the closed vocabulary and release
 * version.
 */

export const PURGE_SURFACE_REGISTRY_VERSION = "purge-surface-registry:v1" as const;
export const PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION =
  "purge-external-integration-manifest:v1" as const;
export const PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION =
  "purge-workflow-subject-manifest:v1" as const;
export const PURGE_SURFACE_REGISTRY_LEGACY_VERSION =
  "purge-surface-registry:legacy" as const;
export const PURGE_EXTERNAL_INTEGRATION_MANIFEST_LEGACY_VERSION =
  "purge-external-integration-manifest:legacy" as const;
export const PURGE_WORKFLOW_SUBJECT_MANIFEST_LEGACY_VERSION =
  "purge-workflow-subject-manifest:legacy" as const;

export const PURGE_WORKFLOW_SUBJECT_MANIFEST = deepFreeze({
  commandType: "owner_full_purge",
  eventType: "owner_full_purge_requested",
  subjectTypes: {
    appUser: "app_user",
    conversationEventRevision: "conversation_event_revision",
    dailySession: "daily_session",
    entity: "entity",
    memoryClaim: "memory_claim",
  },
  version: PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
} as const);

export type PurgeSurfaceDisposition =
  | "delete"
  | "content_purge"
  | "retain_owner_envelope"
  | "retain_governance";

export type PurgeSurfaceOwnerResolution =
  | Readonly<{ kind: "direct_user_id"; column: "user_id" }>
  | Readonly<{ kind: "daily_session_id"; column: "daily_session_id" }>
  | Readonly<{ kind: "evidence_item_id"; column: "evidence_item_id" }>
  | Readonly<{
      kind: "evidence_source_snapshot_id";
      column: "evidence_source_snapshot_id";
    }>
  | Readonly<{ kind: "journal_statement_id"; column: "journal_statement_id" }>
  | Readonly<{
      kind: "journal_generation_command_id";
      column: "generation_command_id";
    }>
  | Readonly<{ kind: "generation_command_id"; column: "generation_command_id" }>
  | Readonly<{
      kind: "rolling_summary_command_id";
      column: "rolling_summary_command_id";
    }>
  | Readonly<{
      kind: "dialogue_state_command_id";
      column: "dialogue_state_command_id";
    }>
  | Readonly<{
      kind: "conversation_action_execution_id";
      column: "action_execution_id";
    }>
  | Readonly<{
      kind: "auth_session_token_hash";
      column: "session_token_hash";
    }>
  | Readonly<{ kind: "owner_workflow_command" }>
  | Readonly<{ kind: "owner_outbox_event" }>
  | Readonly<{ kind: "owner_purge_order_id"; column: "owner_purge_order_id" }>
  | Readonly<{ kind: "ordinary_entity" }>
  | Readonly<{ kind: "ordinary_entity_version" }>
  | Readonly<{ kind: "owner_envelope" }>;

export type PurgeSurfaceReadDeadlinePolicy =
  | Readonly<{ kind: "none" }>
  | Readonly<{
      kind: "active_system_deleted_plus_days";
      days: 30;
    }>;

export type PurgeSurfaceSchemaObject = Readonly<{
  kind: "table" | "index";
  name: string;
}>;

export type PurgeSurfaceEntry = Readonly<{
  surfaceId: string;
  surfaceKind: "postgres_table";
  ownerResolution: PurgeSurfaceOwnerResolution;
  disposition: PurgeSurfaceDisposition;
  privateContentFields: readonly string[];
  clearHandler: string;
  verifyHandler: string;
  receiptDestination: string;
  readDeadlinePolicy: PurgeSurfaceReadDeadlinePolicy;
  restoreReapplyHandler: string;
  introducedBySchemaOrIntegration: string;
  schemaObjects: readonly PurgeSurfaceSchemaObject[];
  clearOrder: number;
}>;

export type PurgeSurfaceExternalIntegration = Readonly<{
  integrationId: string;
  surfaceKind: "external_integration";
  ownerResolution: PurgeSurfaceOwnerResolution;
  disposition: PurgeSurfaceDisposition;
  privateContentFields: readonly string[];
  clearHandler: string;
  verifyHandler: string;
  receiptDestination: string;
  readDeadlinePolicy: PurgeSurfaceReadDeadlinePolicy;
  restoreReapplyHandler: string;
  introducedBySchemaOrIntegration: string;
}>;

export type PurgeSurfaceRegistrySnapshot = Readonly<{
  registryVersion: typeof PURGE_SURFACE_REGISTRY_VERSION;
  externalIntegrationManifestVersion: typeof PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION;
  workflowSubjectManifestVersion: typeof PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION;
  registeredColumns: readonly string[];
  nonPrivateColumns: readonly string[];
  columnManifestHash: string;
  constraintManifestHash: string;
  foreignKeyManifestHash: string;
  indexManifestHash: string;
  surfaces: readonly PurgeSurfaceEntry[];
  externalIntegrations: readonly PurgeSurfaceExternalIntegration[];
}>;

export type PurgeSurfaceSchemaInventory = Readonly<{
  tables: readonly string[];
  indexes: readonly Readonly<{
    name: string;
    table: string;
    definition?: string;
  }>[];
  foreignKeys: readonly string[];
  columns?: readonly string[];
  constraints?: readonly string[];
  externalIntegrationManifestVersion?: string;
  externalIntegrations?: readonly string[];
}>;

export type PurgeSurfaceInventoryValidation = Readonly<
  | {
      ok: true;
      registeredTables: readonly string[];
      registeredIndexes: readonly string[];
    }
  | {
      ok: false;
      missingTables: readonly string[];
      missingIndexes: readonly string[];
      missingExternalIntegrations: readonly string[];
      registryObjectsMissingFromSchema: readonly string[];
      registryColumnsMissingFromSchema: readonly string[];
      schemaColumnsMissingFromRegistry: readonly string[];
      registryExternalIntegrationsMissingFromInventory: readonly string[];
      foreignKeyManifestMismatch: Readonly<{
        expected: string;
        actual: string;
      }> | null;
      externalIntegrationManifestVersionMismatch: Readonly<{
        expected: string;
        actual: string | null;
      }> | null;
      columnManifestMismatch: Readonly<{
        expected: string;
        actual: string;
      }> | null;
      constraintManifestMismatch: Readonly<{
        expected: string;
        actual: string;
      }> | null;
      indexManifestMismatch: Readonly<{
        expected: string;
        actual: string;
      }> | null;
      indexTableMismatches: readonly Readonly<{
        name: string;
        registeredTable: string;
        inventoryTable: string;
      }>[];
    }
>;

type SurfaceDefinition = Readonly<{
  table: string;
  indexes?: readonly string[];
  ownerResolution: PurgeSurfaceOwnerResolution;
  disposition?: PurgeSurfaceDisposition;
  /** Every table must explicitly classify its private content columns. */
  privateContentFields: readonly string[];
  clearHandler?: string;
  verifyHandler?: string;
  receiptDestination?: string;
  readDeadlinePolicy?: PurgeSurfaceReadDeadlinePolicy;
  restoreReapplyHandler?: string;
  introducedBySchemaOrIntegration: string;
  clearOrder: number;
}>;

function tableSurface(definition: SurfaceDefinition): PurgeSurfaceEntry {
  const indexes = definition.indexes ?? [];
  return {
    clearHandler: definition.clearHandler ?? "delete_owner_rows",
    clearOrder: definition.clearOrder,
    disposition: definition.disposition ?? "delete",
    introducedBySchemaOrIntegration: definition.introducedBySchemaOrIntegration,
    ownerResolution: definition.ownerResolution,
    privateContentFields: definition.privateContentFields,
    readDeadlinePolicy: definition.readDeadlinePolicy ?? { kind: "none" },
    receiptDestination: definition.receiptDestination ?? "business_database",
    restoreReapplyHandler:
      definition.restoreReapplyHandler ?? "owner-purge-reapply:v1",
    schemaObjects: [
      { kind: "table", name: definition.table },
      ...indexes.map((name) => ({ kind: "index" as const, name })),
    ],
    surfaceId: definition.table,
    surfaceKind: "postgres_table",
    verifyHandler: definition.verifyHandler ?? "verify_owner_rows_empty",
  };
}

const directUser = {
  kind: "direct_user_id",
  column: "user_id",
} as const;
const dailySession = {
  kind: "daily_session_id",
  column: "daily_session_id",
} as const;
const ownerEnvelope = { kind: "owner_envelope" } as const;

/**
 * All owner-scoped tables currently present through migration 0044. Indexes
 * are attached to their table surface so adding an index is still a checked
 * schema-object change, while the table remains the executable clear unit.
 */
export const PURGE_SURFACE_REGISTRY: readonly PurgeSurfaceEntry[] = [
  tableSurface({
    table: "app_users",
    ownerResolution: ownerEnvelope,
    disposition: "retain_owner_envelope",
    privateContentFields: [],
    clearHandler: "retain_owner_envelope",
    verifyHandler: "verify_owner_envelope",
    introducedBySchemaOrIntegration: "0001_foundation.sql",
    clearOrder: 990,
  }),
  tableSurface({
    table: "internal_owner_identities",
    ownerResolution: directUser,
    disposition: "retain_owner_envelope",
    privateContentFields: [],
    clearHandler: "retain_owner_envelope",
    verifyHandler: "verify_owner_envelope",
    introducedBySchemaOrIntegration: "0001_foundation.sql",
    clearOrder: 991,
  }),
  tableSurface({
    table: "auth_sessions",
    privateContentFields: ["session_token_hash"],
    indexes: ["auth_sessions_user_id_idx", "auth_sessions_expires_at_idx"],
    ownerResolution: directUser,
    clearHandler: "delete_owner_rows",
    introducedBySchemaOrIntegration: "0001_foundation.sql",
    clearOrder: 940,
  }),
  tableSurface({
    table: "daily_sessions",
    privateContentFields: [],
    indexes: ["daily_sessions_one_active_per_user_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0002_user_text_conversation.sql",
    clearOrder: 920,
  }),
  tableSurface({
    table: "interaction_turns",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0002_user_text_conversation.sql",
    clearOrder: 910,
  }),
  tableSurface({
    table: "conversation_events",
    privateContentFields: [],
    indexes: [
      "conversation_events_primary_user_turn_idx",
      "conversation_events_current_revision_idx",
      "conversation_events_assistant_generation_command_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0002_user_text_conversation.sql",
    clearOrder: 900,
  }),
  tableSurface({
    table: "conversation_event_revisions",
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: ["canonical_text"],
    clearHandler: "tombstone_conversation_revisions",
    verifyHandler: "verify_conversation_revisions_purged",
    introducedBySchemaOrIntegration: "0002_user_text_conversation.sql",
    clearOrder: 10,
  }),
  tableSurface({
    table: "generation_commands",
    privateContentFields: ["source_snapshot", "input_manifest"],
    indexes: [
      "generation_commands_recovery_due_idx",
      "generation_commands_action_finalization_idx",
      "generation_commands_one_decision_per_turn_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0003_complete_assistant_response.sql",
    clearOrder: 890,
  }),
  tableSurface({
    table: "model_run_attempts",
    privateContentFields: [],
    indexes: ["model_run_attempts_recovery_scan_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0003_complete_assistant_response.sql",
    clearOrder: 880,
  }),
  tableSurface({
    table: "bio_validation_findings",
    ownerResolution: directUser,
    privateContentFields: ["finding_code"],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 20,
  }),
  tableSurface({
    table: "bio_coverage_members",
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 21,
  }),
  tableSurface({
    table: "bio_claim_links",
    indexes: ["bio_claim_links_owner_version_idx"],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 22,
  }),
  tableSurface({
    table: "bio_coverage_units",
    indexes: ["bio_coverage_units_owner_version_idx"],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 23,
  }),
  tableSurface({
    table: "bio_statements",
    ownerResolution: directUser,
    privateContentFields: ["statement_text"],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 24,
  }),
  tableSurface({
    table: "bio_atomic_propositions",
    ownerResolution: directUser,
    privateContentFields: ["proposition_text"],
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 25,
  }),
  tableSurface({
    table: "bio_versions",
    indexes: ["bio_versions_owner_status_idx"],
    ownerResolution: directUser,
    privateContentFields: [
      "source_manifest",
      "presentation_locale",
      "content_expires_at",
    ],
    clearHandler: "purge_bio_versions",
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 26,
  }),
  tableSurface({
    table: "bios",
    indexes: ["bios_one_current_version_idx"],
    ownerResolution: directUser,
    privateContentFields: [
      "current_version_id",
      "current_source_revision",
      "current_data_epoch",
    ],
    clearHandler: "purge_bios",
    introducedBySchemaOrIntegration:
      "0044_1a3b_model_roles_and_bio_read_schema.sql",
    clearOrder: 27,
  }),
  tableSurface({
    table: "episode_versions",
    indexes: [
      "episode_versions_supersedes_once_idx",
      "episode_versions_episode_idx",
      "episode_versions_owner_status_idx",
      "episode_versions_enrichment_pause_idx",
    ],
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: ["label", "content"],
    clearHandler: "purge_episode_versions",
    verifyHandler: "verify_episode_versions_purged",
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 40,
  }),
  tableSurface({
    table: "episodes",
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: ["episode_kind_id", "current_version_id"],
    clearHandler: "purge_episodes",
    verifyHandler: "verify_episodes_purged",
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 41,
  }),
  tableSurface({
    table: "episode_candidates",
    indexes: [
      "episode_candidates_terminal_fingerprint_idx",
      "episode_candidates_pending_idx",
      "episode_candidates_terminal_expiry_idx",
    ],
    ownerResolution: directUser,
    privateContentFields: [
      "proposed_existing_episode_id",
      "proposed_label",
      "proposed_temporal_anchor",
      "proposed_phase",
      "explicit_continuity_span",
      "admission_reason_code",
      "disposition_reason_code",
      "dedupe_fingerprint",
      "dedupe_fingerprint_key_version",
    ],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 42,
  }),
  tableSurface({
    table: "episode_candidate_evidence_links",
    indexes: ["episode_candidate_evidence_links_candidate_idx"],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 43,
  }),
  tableSurface({
    table: "episode_candidate_entity_links",
    indexes: [
      "episode_candidate_entity_links_candidate_idx",
      "episode_candidate_entity_links_entity_idx",
    ],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 44,
  }),
  tableSurface({
    table: "episode_evidence_links",
    indexes: [
      "episode_evidence_links_version_idx",
      "episode_evidence_links_evidence_idx",
    ],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 45,
  }),
  tableSurface({
    table: "episode_version_entity_links",
    indexes: [
      "episode_version_entity_links_version_idx",
      "episode_version_entity_links_entity_idx",
    ],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 46,
  }),
  tableSurface({
    table: "episode_build_runs",
    indexes: ["episode_build_runs_pending_upgrade_idx"],
    ownerResolution: directUser,
    privateContentFields: [],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 47,
  }),
  tableSurface({
    table: "episode_impact_reviews",
    indexes: ["episode_impact_reviews_pending_idx"],
    ownerResolution: directUser,
    privateContentFields: ["trigger_ref_id"],
    introducedBySchemaOrIntegration: "0045_episode_domain.sql",
    clearOrder: 48,
  }),
  tableSurface({
    table: "compiled_contexts",
    privateContentFields: [
      "content_hmac",
      "sections",
      "rolling_summary",
      "retrieval_manifest",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0003_complete_assistant_response.sql",
    clearOrder: 860,
  }),
  tableSurface({
    table: "compiled_context_revision_refs",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0003_complete_assistant_response.sql",
    clearOrder: 850,
  }),
  tableSurface({
    table: "provider_egress_dispositions",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0003_complete_assistant_response.sql",
    clearOrder: 870,
  }),
  tableSurface({
    table: "provider_egress_consents",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0005_provider_egress_policy.sql",
    clearOrder: 930,
  }),
  tableSurface({
    table: "internal_diagnostic_access_grants",
    privateContentFields: ["session_token_hash"],
    ownerResolution: {
      kind: "auth_session_token_hash",
      column: "session_token_hash",
    },
    introducedBySchemaOrIntegration: "0005_provider_egress_policy.sql",
    clearOrder: 941,
  }),
  tableSurface({
    table: "sensitive_access_audits",
    indexes: ["sensitive_access_audits_user_time_idx"],
    ownerResolution: directUser,
    disposition: "retain_owner_envelope",
    privateContentFields: ["target_type", "target_id"],
    clearHandler: "redact_sensitive_access_audits",
    verifyHandler: "verify_sensitive_access_audits_redacted",
    readDeadlinePolicy: { kind: "active_system_deleted_plus_days", days: 30 },
    introducedBySchemaOrIntegration: "0005_provider_egress_policy.sql",
    clearOrder: 1,
  }),
  tableSurface({
    table: "owner_purge_operational_metadata",
    indexes: ["owner_purge_operational_metadata_order_idx"],
    ownerResolution: {
      kind: "owner_purge_order_id",
      column: "owner_purge_order_id",
    },
    disposition: "retain_owner_envelope",
    privateContentFields: [],
    clearHandler: "capture_owner_purge_operational_metadata",
    verifyHandler: "verify_owner_purge_operational_metadata",
    readDeadlinePolicy: { kind: "active_system_deleted_plus_days", days: 30 },
    introducedBySchemaOrIntegration: "0044_purge_surface_registry.sql",
    clearOrder: 2,
  }),
  tableSurface({
    table: "continuous_exchange_inactivity_evaluations",
    privateContentFields: [],
    indexes: ["continuous_exchange_inactivity_evaluations_due_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0005_continuous_exchange_end.sql",
    clearOrder: 840,
  }),
  tableSurface({
    table: "workflow_commands",
    privateContentFields: [],
    ownerResolution: { kind: "owner_workflow_command" },
    clearHandler: "delete_owner_workflow_commands",
    verifyHandler: "verify_owner_workflow_commands_empty",
    introducedBySchemaOrIntegration: "0009_journal_eligibility_outbox.sql",
    // Keep Daily Session rows alive until this scope has resolved its
    // subject IDs; the workflow adapter must run before the session delete.
    clearOrder: 906,
  }),
  tableSurface({
    table: "outbox_events",
    privateContentFields: [],
    indexes: [
      "outbox_events_pending_due_idx",
      "outbox_events_leased_expires_idx",
      "outbox_events_one_per_aggregate_event_idx",
    ],
    ownerResolution: { kind: "owner_outbox_event" },
    clearHandler: "delete_owner_outbox_events",
    verifyHandler: "verify_owner_outbox_events_empty",
    introducedBySchemaOrIntegration: "0009_journal_eligibility_outbox.sql",
    clearOrder: 905,
  }),
  tableSurface({
    table: "daily_session_date_outcomes",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0009_journal_eligibility_outbox.sql",
    clearOrder: 830,
  }),
  tableSurface({
    table: "evidence_source_snapshots",
    privateContentFields: ["champion_snapshot"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0010_typed_user_evidence.sql",
    clearOrder: 630,
  }),
  tableSurface({
    table: "evidence_items",
    privateContentFields: ["locator_key"],
    indexes: ["evidence_items_snapshot_idx", "evidence_items_owner_boundary_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0010_typed_user_evidence.sql",
    clearOrder: 610,
  }),
  tableSurface({
    table: "evidence_lineage",
    privateContentFields: [],
    ownerResolution: { kind: "evidence_item_id", column: "evidence_item_id" },
    introducedBySchemaOrIntegration: "0010_typed_user_evidence.sql",
    clearOrder: 600,
  }),
  tableSurface({
    table: "evidence_model_run_attempts",
    privateContentFields: ["result_metadata"],
    ownerResolution: {
      kind: "evidence_source_snapshot_id",
      column: "evidence_source_snapshot_id",
    },
    indexes: ["evidence_model_run_attempts_snapshot_idx"],
    introducedBySchemaOrIntegration: "0012_journal_workflow_outcomes.sql",
    clearOrder: 620,
  }),
  tableSurface({
    table: "journal_workflow_outcomes",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0012_journal_workflow_outcomes.sql",
    clearOrder: 580,
  }),
  tableSurface({
    table: "journal_generation_commands",
    privateContentFields: ["guidance_ciphertext"],
    indexes: [
      "journal_generation_commands_automatic_identity_idx",
      "journal_generation_commands_action_execution_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 570,
  }),
  tableSurface({
    table: "journal_model_run_attempts",
    privateContentFields: ["result_metadata"],
    ownerResolution: {
      kind: "journal_generation_command_id",
      column: "generation_command_id",
    },
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 560,
  }),
  tableSurface({
    table: "journals",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 550,
  }),
  tableSurface({
    table: "journal_versions",
    privateContentFields: [],
    indexes: [
      "journal_versions_one_successor_per_predecessor_idx",
      "journal_versions_automatic_identity_idx",
      "journal_versions_command_identity_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 540,
  }),
  tableSurface({
    table: "journal_statements",
    privateContentFields: ["statement_text"],
    indexes: ["journal_statements_owner_boundary_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 520,
  }),
  tableSurface({
    table: "journal_statement_evidence_links",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 500,
  }),
  tableSurface({
    table: "journal_statement_entity_links",
    privateContentFields: [],
    indexes: ["journal_statement_entity_links_lookup_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0040_entity_identity_correction.sql",
    clearOrder: 120,
  }),
  tableSurface({
    table: "journal_validation_results",
    privateContentFields: [],
    ownerResolution: {
      kind: "daily_session_id",
      column: "daily_session_id",
    },
    introducedBySchemaOrIntegration: "0011_journal_versions.sql",
    clearOrder: 530,
  }),
  tableSurface({
    table: "journal_diagnostic_findings",
    privateContentFields: [],
    indexes: ["journal_diagnostic_findings_statement_idx"],
    ownerResolution: {
      kind: "journal_statement_id",
      column: "journal_statement_id",
    },
    introducedBySchemaOrIntegration: "0025_journal_diagnostic_findings.sql",
    clearOrder: 510,
  }),
  tableSurface({
    table: "rolling_summary_commands",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0015_rolling_summary.sql",
    clearOrder: 730,
  }),
  tableSurface({
    table: "rolling_summary_command_source_refs",
    privateContentFields: [],
    ownerResolution: {
      kind: "rolling_summary_command_id",
      column: "rolling_summary_command_id",
    },
    introducedBySchemaOrIntegration: "0015_rolling_summary.sql",
    clearOrder: 710,
  }),
  tableSurface({
    table: "rolling_summary_versions",
    privateContentFields: ["content"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0015_rolling_summary.sql",
    clearOrder: 720,
  }),
  tableSurface({
    table: "current_rolling_summaries",
    privateContentFields: [],
    ownerResolution: dailySession,
    introducedBySchemaOrIntegration: "0015_rolling_summary.sql",
    clearOrder: 700,
  }),
  tableSurface({
    table: "dialogue_state_commands",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0016_dialogue_state.sql",
    clearOrder: 790,
  }),
  tableSurface({
    table: "dialogue_state_command_source_refs",
    privateContentFields: [],
    ownerResolution: {
      kind: "dialogue_state_command_id",
      column: "dialogue_state_command_id",
    },
    introducedBySchemaOrIntegration: "0016_dialogue_state.sql",
    clearOrder: 780,
  }),
  tableSurface({
    table: "dialogue_state_versions",
    privateContentFields: ["content"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0016_dialogue_state.sql",
    clearOrder: 770,
  }),
  tableSurface({
    table: "current_dialogue_states",
    privateContentFields: [],
    ownerResolution: dailySession,
    introducedBySchemaOrIntegration: "0016_dialogue_state.sql",
    clearOrder: 760,
  }),
  tableSurface({
    table: "current_curiosity_stop_signals",
    privateContentFields: [],
    ownerResolution: dailySession,
    introducedBySchemaOrIntegration: "0027_curiosity_stop_signal.sql",
    clearOrder: 740,
  }),
  tableSurface({
    table: "curiosity_stop_signals",
    privateContentFields: ["content"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0027_curiosity_stop_signal.sql",
    clearOrder: 750,
  }),
  tableSurface({
    table: "current_safety_postures",
    privateContentFields: [],
    ownerResolution: dailySession,
    introducedBySchemaOrIntegration: "0028_safety_posture.sql",
    clearOrder: 800,
  }),
  tableSurface({
    table: "safety_postures",
    ownerResolution: directUser,
    privateContentFields: ["content"],
    introducedBySchemaOrIntegration: "0028_safety_posture.sql",
    clearOrder: 810,
  }),
  tableSurface({
    table: "safety_posture_alerts",
    privateContentFields: [],
    indexes: ["safety_posture_alerts_session_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0028_safety_posture.sql",
    clearOrder: 820,
  }),
  tableSurface({
    table: "entities",
    indexes: ["entities_current_version_idx"],
    ownerResolution: { kind: "ordinary_entity" },
    disposition: "content_purge",
    privateContentFields: ["current_version_id", "deleted_at"],
    clearHandler: "purge_ordinary_entities",
    verifyHandler: "verify_ordinary_entities_purged",
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 31,
  }),
  tableSurface({
    table: "user_self_entities",
    ownerResolution: directUser,
    disposition: "retain_owner_envelope",
    privateContentFields: [],
    clearHandler: "retain_owner_envelope",
    verifyHandler: "verify_owner_envelope",
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 992,
  }),
  tableSurface({
    table: "entity_versions",
    indexes: ["entity_versions_owner_boundary_idx"],
    ownerResolution: { kind: "ordinary_entity_version" },
    disposition: "content_purge",
    privateContentFields: ["entity_kind_id", "status", "merged_into_entity_id"],
    clearHandler: "purge_ordinary_entity_versions",
    verifyHandler: "verify_ordinary_entity_versions_purged",
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 32,
  }),
  tableSurface({
    table: "entity_labels",
    privateContentFields: ["label", "normalized_label"],
    indexes: [
      "entity_labels_current_primary_idx",
      "entity_labels_current_alias_idx",
      "entity_labels_lookup_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 350,
  }),
  tableSurface({
    table: "entity_mentions",
    privateContentFields: [],
    indexes: ["entity_mentions_revision_span_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 340,
  }),
  tableSurface({
    table: "entity_mention_candidates",
    privateContentFields: ["matched_label"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0031_entity_domain_foundation.sql",
    clearOrder: 330,
  }),
  tableSurface({
    table: "memory_claims",
    indexes: ["memory_claims_user_predicate_idx", "memory_claims_current_version_idx"],
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: [
      "canonical_key",
      "subject_entity_id",
      "object_entity_id",
      "predicate_id",
      "scope_key",
      "current_version_id",
      "deleted_at",
    ],
    clearHandler: "purge_memory_claims",
    verifyHandler: "verify_memory_claims_purged",
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 30,
  }),
  tableSurface({
    table: "memory_claim_versions",
    indexes: [
      "memory_claim_versions_owner_boundary_idx",
      "memory_claim_versions_claim_idx",
    ],
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: [
      "typed_value",
      "temporal_status",
      "valid_from",
      "valid_from_precision",
      "valid_to",
      "valid_to_precision",
      "subject_entity_version_id",
      "object_entity_version_id",
    ],
    clearHandler: "purge_memory_claim_versions",
    verifyHandler: "verify_memory_claim_versions_purged",
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 33,
  }),
  tableSurface({
    table: "claim_evidence_links",
    privateContentFields: [],
    indexes: ["claim_evidence_links_version_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 270,
  }),
  tableSurface({
    table: "memory_candidates",
    privateContentFields: [
      "proposed_concept",
      "proposed_object_value",
      "proposed_scope_key",
      "proposed_temporal_status",
      "proposed_valid_from",
      "proposed_valid_to",
      "proposed_qualifiers",
      "dedupe_fingerprint",
      "dedupe_fingerprint_key_version",
    ],
    indexes: [
      "memory_candidates_user_status_idx",
      "memory_candidates_terminal_fingerprint_idx",
      "memory_candidates_pending_review_idx",
      "memory_candidates_registry_release_idx",
      "memory_candidates_terminal_content_expiry_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 290,
  }),
  // Candidate Review governance (SPEC #193 §8.3, 0046): the owner-scoped
  // Proposal link is the only governance row that points at a private
  // Candidate — Full Purge deletes it. The Proposal identity and its
  // immutable version history are structurally user-content-free global
  // governance records (no user_id column, no owner foreign key): they are
  // retained across Full Purge and therefore sit OUTSIDE the owner-scoped
  // registry inventory, like the reference Registry tables.
  tableSurface({
    table: "predicate_change_proposal_candidate_links",
    privateContentFields: [],
    indexes: ["predicate_change_proposal_candidate_links_proposal_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0046_predicate_candidate_governance.sql",
    clearOrder: 292,
  }),
  // Content-free operator audit for review commands (SPEC §8.1): retained
  // owner envelope with the target identity redacted by Full Purge and a
  // 30-day read deadline (ADR-0130).
  tableSurface({
    table: "candidate_review_audits",
    privateContentFields: ["target_type", "target_id"],
    indexes: ["candidate_review_audits_user_time_idx"],
    ownerResolution: directUser,
    disposition: "retain_owner_envelope",
    clearHandler: "redact_sensitive_access_audits",
    verifyHandler: "verify_sensitive_access_audits_redacted",
    readDeadlinePolicy: { kind: "active_system_deleted_plus_days", days: 30 },
    introducedBySchemaOrIntegration: "0046_predicate_candidate_governance.sql",
    clearOrder: 293,
  }),
  tableSurface({
    table: "memory_candidate_evidence_links",
    privateContentFields: [],
    indexes: ["memory_candidate_evidence_links_candidate_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 280,
  }),
  tableSurface({
    table: "memory_forget_requests",
    privateContentFields: [
      "canonical_side",
      "qualifier_key",
      "qualifier_typed_value",
    ],
    indexes: [
      "memory_forget_requests_revision_idx",
      "memory_forget_requests_claim_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 320,
  }),
  tableSurface({
    table: "memory_forget_evidence_exclusions",
    privateContentFields: ["canonical_side", "qualifier_key"],
    indexes: ["memory_forget_evidence_exclusions_claim_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 310,
  }),
  tableSurface({
    table: "memory_forget_reversals",
    privateContentFields: [],
    indexes: ["memory_forget_reversals_active_request_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0033_memory_claim_domain.sql",
    clearOrder: 300,
  }),
  tableSurface({
    table: "fast_path_extraction_runs",
    privateContentFields: [],
    indexes: ["fast_path_extraction_runs_session_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0034_fast_path_extraction.sql",
    clearOrder: 220,
  }),
  tableSurface({
    table: "fast_path_session_items",
    privateContentFields: ["summary"],
    indexes: ["fast_path_session_items_session_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0034_fast_path_extraction.sql",
    clearOrder: 190,
  }),
  tableSurface({
    table: "entity_resolve_gate_outcomes",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0034_fast_path_extraction.sql",
    clearOrder: 200,
  }),
  tableSurface({
    table: "entity_clarification_proposals",
    privateContentFields: ["topic_key", "question_text"],
    indexes: ["entity_clarification_proposals_session_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0034_fast_path_extraction.sql",
    clearOrder: 210,
  }),
  tableSurface({
    table: "memory_consolidation_runs",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0035_memory_consolidation.sql",
    clearOrder: 180,
  }),
  tableSurface({
    table: "memory_consolidation_diffs",
    privateContentFields: [],
    indexes: ["memory_consolidation_diffs_run_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0035_memory_consolidation.sql",
    clearOrder: 170,
  }),
  tableSurface({
    table: "memory_claim_version_qualifiers",
    indexes: ["memory_claim_version_qualifiers_version_idx"],
    ownerResolution: directUser,
    disposition: "content_purge",
    privateContentFields: ["typed_value"],
    clearHandler: "purge_memory_claim_version_qualifiers",
    verifyHandler: "verify_memory_claim_version_qualifiers_purged",
    introducedBySchemaOrIntegration: "0036_relationship_claims_qualifiers_hints.sql",
    clearOrder: 34,
  }),
  tableSurface({
    table: "memory_claim_version_qualifier_evidence",
    privateContentFields: [],
    indexes: ["memory_claim_version_qualifier_evidence_qualifier_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0036_relationship_claims_qualifiers_hints.sql",
    clearOrder: 260,
  }),
  tableSurface({
    table: "relationship_resolver_hints",
    privateContentFields: ["role_term", "phrase"],
    indexes: ["relationship_resolver_hints_resolution_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0036_relationship_claims_qualifiers_hints.sql",
    clearOrder: 250,
  }),
  tableSurface({
    table: "claim_retrieval_projections",
    privateContentFields: ["retrieval_text", "lexical_terms", "english_search"],
    indexes: [
      "claim_retrieval_projections_user_active_idx",
      "claim_retrieval_projections_claim_idx",
      "claim_retrieval_projections_lexical_terms_idx",
      "claim_retrieval_projections_english_search_idx",
    ],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0037_structured_lexical_retrieval.sql",
    clearOrder: 240,
  }),
  tableSurface({
    table: "retrieval_runs",
    privateContentFields: ["normalized_query_terms"],
    indexes: ["retrieval_runs_user_started_idx", "retrieval_runs_compiled_context_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0037_structured_lexical_retrieval.sql",
    clearOrder: 230,
  }),
  tableSurface({
    table: "retrieval_run_candidates",
    privateContentFields: ["matched_fields", "matched_terms", "trust_fence_results"],
    indexes: ["retrieval_run_candidates_run_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0037_structured_lexical_retrieval.sql",
    clearOrder: 225,
  }),
  tableSurface({
    table: "memory_claim_corrections",
    privateContentFields: [],
    indexes: ["memory_claim_corrections_claim_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0038_memory_trust_actions.sql",
    clearOrder: 150,
  }),
  tableSurface({
    table: "memory_impression_vetoes",
    privateContentFields: [],
    indexes: ["memory_impression_vetoes_claim_active_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0038_memory_trust_actions.sql",
    clearOrder: 160,
  }),
  tableSurface({
    table: "memory_correction_followups",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0038_memory_trust_actions.sql",
    clearOrder: 140,
  }),
  tableSurface({
    table: "conversation_action_handles",
    privateContentFields: ["handle"],
    indexes: ["conversation_action_handles_lookup_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0019_conversation_action_admission.sql",
    clearOrder: 400,
  }),
  tableSurface({
    table: "conversation_action_executions",
    privateContentFields: ["target_handle", "disposition"],
    indexes: ["conversation_action_in_flight_target_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0019_conversation_action_admission.sql",
    clearOrder: 420,
  }),
  tableSurface({
    table: "conversation_action_receipts",
    privateContentFields: ["disposition_detail"],
    indexes: ["conversation_action_receipts_key_idx"],
    ownerResolution: {
      kind: "conversation_action_execution_id",
      column: "action_execution_id",
    },
    introducedBySchemaOrIntegration: "0019_conversation_action_admission.sql",
    clearOrder: 410,
  }),
  tableSurface({
    table: "conversation_action_payloads",
    privateContentFields: ["ciphertext"],
    ownerResolution: {
      kind: "conversation_action_execution_id",
      column: "action_execution_id",
    },
    introducedBySchemaOrIntegration: "0019_conversation_action_admission.sql",
    clearOrder: 411,
  }),
  tableSurface({
    table: "entity_identity_corrections",
    privateContentFields: [],
    indexes: ["entity_identity_corrections_source_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0040_entity_identity_correction.sql",
    clearOrder: 130,
  }),
  tableSurface({
    table: "journal_identity_review_fences",
    privateContentFields: [],
    indexes: ["journal_identity_review_fences_pending_idx"],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0040_entity_identity_correction.sql",
    clearOrder: 110,
  }),
  tableSurface({
    table: "entity_identity_revalidation_runs",
    privateContentFields: [],
    ownerResolution: directUser,
    introducedBySchemaOrIntegration: "0040_entity_identity_correction.sql",
    clearOrder: 100,
  }),
  tableSurface({
    table: "owner_purge_orders",
    indexes: ["owner_purge_orders_pending_scan_idx"],
    ownerResolution: directUser,
    disposition: "retain_governance",
    privateContentFields: [],
    clearHandler: "retain_governance",
    verifyHandler: "verify_owner_purge_order",
    introducedBySchemaOrIntegration: "0019_owner_full_purge.sql",
    clearOrder: 993,
  }),
  tableSurface({
    table: "owner_purge_receipts",
    ownerResolution: {
      kind: "owner_purge_order_id",
      column: "owner_purge_order_id",
    },
    disposition: "retain_governance",
    privateContentFields: [],
    clearHandler: "retain_governance",
    verifyHandler: "verify_owner_purge_receipts",
    introducedBySchemaOrIntegration: "0019_owner_full_purge.sql",
    clearOrder: 994,
  }),
];

/**
 * Complete, explicit field inventory for the owner-scoped tables. The column
 * fingerprint detects any schema change; this allowlist makes the change
 * reviewable and prevents updating only the fingerprint from silently
 * classifying a newly introduced private column as covered.
 */
const PURGE_SURFACE_REGISTERED_COLUMN_LINES = `
app_users|user_id,status,data_epoch,created_at,updated_at
auth_sessions|session_token_hash,user_id,expires_at,created_at,updated_at
bio_atomic_propositions|bio_atomic_proposition_id,bio_version_id,bio_id,user_id,proposition_key,proposition_text,content_purged_at,created_at
bio_claim_links|bio_claim_link_id,bio_version_id,bio_id,user_id,memory_claim_version_id,link_role,support_status,source_revision,expected_data_epoch,created_at
bio_coverage_members|bio_coverage_unit_id,bio_version_id,user_id,memory_claim_version_id,created_at
bio_coverage_units|bio_coverage_unit_id,bio_version_id,bio_id,user_id,unit_key,disposition,coverage_policy_version,source_revision,expected_data_epoch,created_at
bio_statements|bio_statement_id,bio_version_id,bio_id,user_id,ordinal,section_key,statement_key,statement_text,content_purged_at,created_at
bio_validation_findings|bio_validation_finding_id,bio_version_id,bio_id,user_id,bio_statement_id,bio_atomic_proposition_id,finding_code,severity,disposition,created_at
bio_versions|bio_version_id,bio_id,user_id,revision,status,source_revision,expected_data_epoch,source_manifest,presentation_locale,self_entity_id,self_entity_version_id,generation_command_id,writer_model_run_attempt_id,validator_generation_command_id,validator_model_run_attempt_id,content_expires_at,content_purged_at,created_at
bios|bio_id,user_id,current_version_id,current_source_revision,current_data_epoch,created_at,updated_at
claim_evidence_links|claim_evidence_link_id,memory_claim_version_id,user_id,evidence_item_id,link_role,status,created_at
candidate_review_audits|candidate_review_audit_id,user_id,command,target_type,target_id,disposition,reason,operator_principal_id,policy_version,recorded_at
predicate_change_proposal_candidate_links|predicate_change_proposal_candidate_link_id,user_id,memory_candidate_id,predicate_change_proposal_id,created_at
claim_retrieval_projections|claim_retrieval_projection_id,user_id,memory_claim_id,memory_claim_version_id,locale,view_direction,retrieval_text,lexical_terms,english_search,projection_policy_version,status,created_at,content_purged_at
compiled_context_revision_refs|compiled_context_id,user_id,conversation_event_revision_id,ordinal,actor,estimated_tokens,sequence_no,section,selection_order
compiled_contexts|compiled_context_id,user_id,generation_command_id,compiler_version,dialogue_revision,source_revision,locale,section_budgets,total_tokens,degraded_reason,content_hmac,created_at,policy_versions,sections,integrity_algorithm,integrity_key_version,rolling_summary,retrieval_manifest
continuous_exchange_inactivity_evaluations|inactivity_evaluation_id,user_id,daily_session_id,continuous_exchange_no,policy_version,expected_dialogue_revision,due_at,evaluated_at,outcome,created_at
conversation_action_executions|action_execution_id,user_id,decision_command_id,request_event_revision_id,action_kind,schema_version,catalog_version,target_handle,target_kind,target_id,target_version_id,daily_session_id,source_revision,expected_data_epoch,idempotency_key,admission_status,execution_status,disposition,created_at,resolved_claim_id,resolved_claim_version_id,resolved_qualifier_id,resolved_entity_id,resolved_entity_version_id,resolved_related_entity_id,resolved_related_entity_version_id,entity_identity_operation
conversation_action_handles|handle,compiled_context_id,user_id,generation_command_id,action_kind,target_kind,target_id,target_version_id,source_revision,expected_data_epoch,created_at,expires_at,target_claim_id,target_claim_version_id,target_qualifier_id
conversation_action_payloads|action_execution_id,payload_schema_version,ciphertext,expires_at,content_purged_at
conversation_action_receipts|action_receipt_id,action_execution_id,receipt_sequence,admission_status,execution_status,disposition,error_code,created_at,receipt_key,resolved_claim_id,resolved_claim_version_id,disposition_detail,resolved_qualifier_id,resolved_entity_id,resolved_entity_version_id,resolved_related_entity_id,resolved_related_entity_version_id,entity_identity_operation
conversation_event_revisions|conversation_event_revision_id,user_id,conversation_event_id,revision,locale,canonical_text,transcript_status,created_by,created_at,content_purged_at
conversation_events|conversation_event_id,user_id,daily_session_id,interaction_turn_id,sequence_no,client_event_id,actor,channel,event_type,current_revision_id,lifecycle_status,created_at,deleted_at,generation_command_id
curiosity_stop_signals|curiosity_stop_signal_id,user_id,daily_session_id,version_no,source_revision,policy_version,content,committed_generation_command_id,created_at
current_curiosity_stop_signals|daily_session_id,curiosity_stop_signal_id,user_id,source_revision,version_no,updated_at
current_dialogue_states|daily_session_id,dialogue_state_version_id,user_id,source_revision,dialogue_revision,covered_through_sequence_no,updated_at
current_rolling_summaries|daily_session_id,rolling_summary_version_id,user_id,covered_through_sequence_no,updated_at
current_safety_postures|daily_session_id,safety_posture_id,user_id,source_revision,version_no,updated_at
daily_session_date_outcomes|daily_session_id,user_id,logical_date,outcome,eligibility_policy_version,source_revision,workflow_receipt_id,computed_at
daily_sessions|daily_session_id,user_id,logical_date,timezone_at_start,started_at,last_activity_at,activity_state,current_continuous_exchange_no,dialogue_revision,source_revision,next_turn_sequence_no,next_event_sequence_no,created_at,updated_at,quiescent_at,quiescent_reason,closure_policy_version
dialogue_state_command_source_refs|dialogue_state_command_id,conversation_event_revision_id,sequence_no
dialogue_state_commands|dialogue_state_command_id,user_id,daily_session_id,expected_data_epoch,source_revision,dialogue_revision,coverage_through_sequence_no,policy_version,prompt_version,model_config_version,status,claimed_at,last_error_code,created_at,claim_id,coverage_key
dialogue_state_versions|dialogue_state_version_id,dialogue_state_command_id,user_id,daily_session_id,version_no,source_revision,dialogue_revision,covered_through_sequence_no,content,created_at
entities|entity_id,user_id,current_version_id,created_at,deleted_at
entity_clarification_proposals|entity_clarification_proposal_id,user_id,daily_session_id,event_revision_id,entity_mention_id,topic_key,semantic_impact,status,question_text,created_at,decided_at,decided_by_event_revision_id
entity_identity_corrections|entity_identity_correction_id,user_id,action_execution_id,request_event_revision_id,operation,source_entity_id,source_entity_version_id,related_entity_id,related_entity_version_id,created_entity_id,created_entity_version_id,promotion_explicit_statement,promotion_independent_revision_count,correction_policy_version,created_at
entity_identity_revalidation_runs|entity_identity_revalidation_run_id,user_id,workflow_command_id,action_execution_id,source_entity_id,source_entity_version_id,affected_claim_count,affected_journal_statement_count,status,created_at,completed_at
entity_labels|entity_label_id,entity_id,user_id,locale,label,normalized_label,label_kind,is_current,source_evidence_id,created_at,content_purged_at
entity_mention_candidates|entity_mention_candidate_id,entity_mention_id,user_id,candidate_entity_id,matched_label,candidate_kind,edit_distance,created_at
entity_mentions|entity_mention_id,user_id,conversation_event_id,event_revision_id,evidence_id,locator_type,start_offset,end_offset,mention_kind,resolved_entity_id,resolution_status,confidence,resolver_policy_version,created_at,content_purged_at
entity_resolve_gate_outcomes|entity_resolve_gate_outcome_id,user_id,entity_mention_id,gate_policy_version,resolver_policy_version,t_auto,verdict,selected_entity_id,confidence,candidate_count,committed,not_committed_reason,created_at
episode_build_runs|episode_build_run_id,user_id,daily_session_id,source_revision,policy_version,expected_data_epoch,generation_command_id,model_run_attempt_id,status,outcome_detail,candidate_count,accepted_count,unresolved_count,rejected_count,error_code,created_at,updated_at
episode_candidate_evidence_links|episode_candidate_evidence_link_id,episode_candidate_id,user_id,evidence_item_id,created_at
episode_candidate_entity_links|episode_candidate_entity_link_id,episode_candidate_id,user_id,entity_id,created_at
episode_candidates|episode_candidate_id,user_id,daily_session_id,source_revision,proposed_episode_kind_id,proposed_existing_episode_id,proposed_label,proposed_temporal_anchor,proposed_phase,explicit_continuity_span,resolution_status,status,admission_reason_code,policy_version,generation_command_id,model_run_attempt_id,predecessor_candidate_id,successor_trigger,material_change_reason_codes,dedupe_fingerprint,dedupe_fingerprint_key_version,reproposal_policy,disposition_reason_code,disposition_policy_version,decided_at,terminal_effective_at,terminal_content_expires_at,created_at,content_purged_at
episode_evidence_links|episode_evidence_link_id,episode_version_id,user_id,evidence_item_id,created_at
episode_impact_reviews|episode_impact_review_id,user_id,episode_version_id,trigger_type,trigger_ref_id,outcome,policy_version,created_at,decided_at
episode_version_entity_links|episode_version_entity_link_id,episode_version_id,user_id,entity_id,created_at
episode_versions|episode_version_id,episode_id,user_id,revision,source_revision,episode_kind_id,status,label,content,policy_version,generation_command_id,model_run_attempt_id,supersedes_version_id,enrichment_paused_at,enrichment_pause_reason,created_at,content_purged_at
episodes|episode_id,user_id,episode_kind_id,current_version_id,status,created_at,deleted_at
entity_versions|entity_version_id,entity_id,user_id,revision,entity_kind_id,status,merged_into_entity_id,supersedes_version_id,created_at,content_purged_at
evidence_items|evidence_item_id,user_id,evidence_source_snapshot_id,source_event_id,source_revision_id,source_actor,source_status,locator_type,locator_key,extraction_policy_version,evidence_role,status,created_at
evidence_lineage|evidence_item_id,command_id,attempt_id,created_at
evidence_model_run_attempts|evidence_model_run_attempt_id,evidence_source_snapshot_id,role,provider,model,config_version,extraction_policy_version,prompt_fingerprint,provider_request_id,provider_completed_at,result_metadata,status,created_at
evidence_source_snapshots|evidence_source_snapshot_id,user_id,daily_session_id,source_revision,extraction_policy_version,command_id,attempt_id,champion_config_version,champion_provider,champion_model,champion_snapshot,champion_provider_policy_version,created_at
fast_path_extraction_runs|fast_path_run_id,user_id,daily_session_id,event_revision_id,event_conversation_event_id,extraction_policy_version,workflow_command_id,model_attempt_id,memory_extract_config_version,memory_extract_model_version,memory_extract_prompt_version,entity_resolve_config_version,role_fallback_used,status,event_committed_at,extracted_at,visibility_lag_ms,visibility_target_met,item_count,mention_count,candidate_count,error_code,created_at,updated_at,retired_at
fast_path_session_items|fast_path_item_id,user_id,daily_session_id,event_revision_id,fast_path_run_id,item_class,summary,memory_candidate_id,entity_mention_id,evidence_item_id,dedupe_key,created_at,retired_at
generation_commands|generation_command_id,user_id,interaction_turn_id,operation_type,intent_key,subject_type,subject_id,input_revision_kind,input_revision_id,prompt_version,product_policy_version,safety_policy_version,relationship_policy_version,locale_policy_version,locale,provider,model,model_snapshot,model_config_version,freshness_policy,expected_data_epoch,status,compiled_context_id,authoritative_result_id,created_at,settled_at,provider_policy_version,consent_policy_version,output_format_version,persona_version,recovery_policy_version,recovery_status,recovery_checked_at,next_recovery_at,harness_policy_version,conversation_action_catalog_version,generation_stage,action_execution_id,action_receipt_sequence,action_execution_status,persona_contract_invariant_version,canonical_persona_version,persona_behavior_anchors_version,model_role,schema_version,role_policy_version,rollout_pin,source_revision,source_snapshot,input_manifest,parameter_snapshot,fallback_mode
interaction_turns|interaction_turn_id,user_id,daily_session_id,client_turn_id,turn_sequence_no,continuous_exchange_no,status,retry_of_interaction_turn_id,started_at,settled_at,created_at,updated_at
internal_diagnostic_access_grants|session_token_hash,capability,status,step_up_authenticated_at,updated_at
internal_owner_identities|owner_slot,issuer,subject,user_id,active,created_at
journal_diagnostic_findings|journal_diagnostic_finding_id,journal_validation_result_id,journal_version_id,journal_statement_id,code,detail_code,created_at
journal_generation_commands|generation_command_id,user_id,daily_session_id,source_revision,generation_policy_version,expected_data_epoch,created_at,generation_kind,action_execution_id,guidance_ciphertext,guidance_expires_at,guidance_content_purged_at
journal_identity_review_fences|journal_identity_review_fence_id,user_id,action_execution_id,journal_statement_id,entity_version_id,source_revision,status,created_at
journal_model_run_attempts|model_run_attempt_id,generation_command_id,role,provider,model,config_version,role_policy_version,prompt_fingerprint,provider_request_id,provider_completed_at,result_metadata,status,created_at
journal_statement_entity_links|journal_statement_entity_link_id,journal_statement_id,entity_version_id,evidence_item_id,user_id,link_role,created_at
journal_statement_evidence_links|journal_statement_id,evidence_item_id,user_id,source_revision,evidence_source_snapshot_id,evidence_role
journal_statements|journal_statement_id,journal_version_id,statement_index,statement_key,statement_text,user_id,source_revision,evidence_source_snapshot_id
journal_validation_results|journal_validation_result_id,journal_version_id,daily_session_id,source_revision,generation_command_id,model_run_attempt_id,programmatic_valid,status,failure_code,validator_version,created_at,diagnostic_status
journal_versions|journal_version_id,journal_id,user_id,daily_session_id,source_revision,generation_policy_version,validator_version,locale,evidence_source_snapshot_id,status,generation_command_id,model_run_attempt_id,created_at,supersedes_version_id,generation_kind
journal_workflow_outcomes|workflow_command_id,user_id,daily_session_id,source_revision,expected_data_epoch,outcome,reason,created_at
journals|journal_id,user_id,daily_session_id,current_version_id,created_at,deleted_at
memory_candidate_evidence_links|memory_candidate_evidence_link_id,memory_candidate_id,user_id,evidence_item_id,created_at
memory_candidates|memory_candidate_id,user_id,candidate_kind,basis,subject_entity_id,subject_entity_mention_id,object_entity_id,object_entity_mention_id,predicate_id,predicate_registry_version,predicate_resolution_status,proposed_concept,mapping_confidence,proposed_object_value,proposed_scope_key,proposed_temporal_status,proposed_valid_from,proposed_valid_from_precision,proposed_valid_to,proposed_valid_to_precision,source_reflection_version_id,generation_command_id,authoritative_model_attempt_id,model_version,prompt_version,extraction_policy_version,status,predicate_review_policy_version,review_eligible_at,review_due_at,registry_release_wait_started_at,registry_release_due_at,disposition_reason_code,disposition_policy_version,decided_at,terminal_effective_at,terminal_content_expires_at,reproposal_policy,predecessor_candidate_id,successor_trigger,material_change_reason_codes,dedupe_fingerprint,dedupe_fingerprint_key_version,created_at,content_purged_at,proposed_qualifiers
memory_claim_corrections|memory_claim_correction_id,user_id,request_event_revision_id,target_claim_id,deactivated_claim_version_id,target_scope,corrected_fact_recorded,correction_policy_version,created_at
memory_claim_version_qualifier_evidence|memory_claim_version_qualifier_evidence_id,memory_claim_version_qualifier_id,user_id,evidence_item_id,created_at
memory_claim_version_qualifiers|memory_claim_version_qualifier_id,memory_claim_version_id,user_id,axis_id,role_side,typed_value,created_by,created_at,content_purged_at
memory_claim_versions|memory_claim_version_id,memory_claim_id,user_id,revision,kind,epistemic_status,status,subject_entity_version_id,object_entity_version_id,typed_value,confidence,temporal_status,valid_from,valid_from_precision,valid_to,valid_to_precision,last_observed_at,supersedes_version_id,created_by,model_version,prompt_version,predicate_registry_version,created_at,content_purged_at
memory_claims|memory_claim_id,user_id,canonical_key,subject_entity_id,object_entity_id,predicate_id,scope_key,current_version_id,created_at,deleted_at,content_purged_at
memory_consolidation_diffs|memory_consolidation_diff_id,memory_consolidation_run_id,user_id,diff_index,diff_kind,memory_candidate_id,memory_claim_id,outcome,reason_code,created_at
memory_consolidation_runs|memory_consolidation_run_id,user_id,consolidation_kind,anchor_date,policy_version,workflow_command_id,expected_data_epoch,model_attempt_id,consolidate_config_version,consolidate_model_version,consolidate_prompt_version,role_fallback_used,status,diff_count,promoted_count,reinforced_count,contested_count,rejected_count,skipped_count,dormant_count,staled_count,purged_count,error_code,created_at,updated_at
memory_correction_followups|memory_correction_followup_id,user_id,workflow_command_id,action_execution_id,target_claim_id,affected_journal_statement_count,followup_policy_version,created_at
memory_forget_evidence_exclusions|memory_forget_evidence_exclusion_id,user_id,memory_forget_request_id,evidence_item_id,exclusion_scope,canonical_side,qualifier_key,status,created_at
memory_forget_requests|memory_forget_request_id,user_id,request_event_revision_id,target_claim_id,target_scope,canonical_side,qualifier_key,qualifier_typed_value,status,applied_claim_version_id,forget_policy_version,created_at,target_qualifier_id
memory_forget_reversals|memory_forget_reversal_id,user_id,memory_forget_request_id,request_event_revision_id,reversal_evidence_id,status,applied_claim_version_id,forget_policy_version,created_at
memory_impression_vetoes|memory_impression_veto_id,user_id,memory_claim_id,vetoed_claim_version_id,request_event_revision_id,status,impression_correction_policy_version,created_at
model_run_attempts|model_run_attempt_id,user_id,generation_command_id,attempt_no,operation_type,provider,model,model_snapshot,prompt_version,status,provider_request_id,started_at,first_token_at,completed_at,input_tokens,output_tokens,cost_micros,finish_reason,error_category,created_at,retry_of_model_run_attempt_id,recovery_status,retry_not_before,recovery_claimed_at,provider_completed_at,attempt_kind,source_attempt_id,provider_egress_event_id,error_code
outbox_events|outbox_event_id,workflow_command_id,aggregate_type,aggregate_id,aggregate_revision,event_type,status,next_attempt_at,lease_owner,lease_expires_at,attempt_count,workflow_receipt_id,last_error_code,payload,created_at,aggregate_coverage,aggregate_data_epoch,cancelled_reason,intent_key
owner_purge_operational_metadata|owner_purge_operational_metadata_id,owner_purge_order_id,user_id,surface_id,operation_type,status,policy_version,provider,role,error_category,attempt_count,recorded_at
owner_purge_orders|owner_purge_order_id,user_id,from_data_epoch,data_epoch,status,confirmation,policy_version,requested_at,access_revoked_at,propagating_at,verifying_at,active_system_deleted_at,retention_pending_at,needs_attention_at,needs_attention_reason,backup_retention_until,last_attempt_at,attempt_count,purge_surface_registry_version,external_integration_manifest_version,workflow_subject_manifest_version
owner_purge_receipts|owner_purge_receipt_id,owner_purge_order_id,destination,destination_disposition,provider_disposition,provider_retention_until,backup_retention_until,recorded_at
provider_egress_consents|user_id,provider,role,consent_policy_version,status,granted_at,revoked_at
provider_egress_dispositions|provider_egress_disposition_id,user_id,model_run_attempt_id,provider,model,role,provider_policy_version,expected_data_epoch,status,error_category,checked_at,dispatched_at,completed_at
relationship_resolver_hints|relationship_resolver_hint_id,user_id,memory_claim_id,memory_claim_version_id,resolved_entity_id,context_entity_id,view_direction,locale,temporal_form,role_side,role_axis_id,role_term,role_source,phrase,rebuilt_at
retrieval_run_candidates|retrieval_run_candidate_id,retrieval_run_id,user_id,memory_claim_version_id,claim_retrieval_projection_id,retrieval_lane,matched_fields,matched_terms,trust_fence_results,rank_components,final_rank,selected_section,selection_reason_codes,rejection_reason_codes,created_at
retrieval_runs|retrieval_run_id,user_id,daily_session_id,source_event_revision_id,compiled_context_id,retrieval_policy_version,query_construction_policy_version,projection_policy_version,query_source_refs,normalized_query_terms,lane_plan,deadline_ms,status,degraded_reason_codes,duration_ms,deadline_exceeded_stage,timings,started_at,completed_at
rolling_summary_command_source_refs|rolling_summary_command_id,conversation_event_revision_id,sequence_no
rolling_summary_commands|rolling_summary_command_id,user_id,daily_session_id,expected_data_epoch,source_revision,dialogue_revision,coverage_start_sequence_no,covered_through_sequence_no,policy_version,minimum_uncovered_event_count,minimum_uncovered_token_count,prompt_version,model_config_version,status,claimed_at,last_error_code,created_at
rolling_summary_versions|rolling_summary_version_id,rolling_summary_command_id,user_id,daily_session_id,version_no,covered_through_sequence_no,content,created_at
safety_posture_alerts|safety_posture_alert_id,user_id,daily_session_id,generation_command_id,policy_version,reason,occurred_at,created_at
safety_postures|safety_posture_id,user_id,daily_session_id,version_no,source_revision,policy_version,content,committed_generation_command_id,created_at
sensitive_access_audits|sensitive_access_audit_id,user_id,capability,target_type,target_id,disposition,reason,policy_version,accessed_at
user_self_entities|user_id,entity_id,created_at
workflow_commands|workflow_command_id,command_type,subject_type,subject_id,source_revision,policy_version,expected_data_epoch,status,created_at,dispatched_at,coverage_through_sequence_no,cancelled_reason,action_execution_id,purge_surface_registry_version,external_integration_manifest_version,workflow_subject_manifest_version,intent_key
`.trim().split("\n");

const PURGE_SURFACE_REGISTERED_COLUMNS = deepFreeze(
  PURGE_SURFACE_REGISTERED_COLUMN_LINES.flatMap((line) => {
    const [table, fieldList] = line.split("|");
    if (!table || !fieldList) {
      throw new Error(`Invalid purge column manifest line: ${line}`);
    }
    return fieldList.split(",").map((field) => `${table}.${field}`);
  }),
);

/**
 * Explicit classification for every registered schema column that is not
 * private content. Keeping this as a separate manifest means a new column
 * cannot be made visible to the inventory gate merely by changing the
 * column fingerprint; it must be deliberately classified as private or
 * non-private in the same review.
 */
const PURGE_SURFACE_REGISTERED_NON_PRIVATE_COLUMN_LINES = `
app_users|user_id,status,data_epoch,created_at,updated_at
auth_sessions|user_id,expires_at,created_at,updated_at
bio_atomic_propositions|bio_atomic_proposition_id,bio_version_id,bio_id,user_id,proposition_key,content_purged_at,created_at
bio_claim_links|bio_claim_link_id,bio_version_id,bio_id,user_id,memory_claim_version_id,link_role,support_status,source_revision,expected_data_epoch,created_at
bio_coverage_members|bio_coverage_unit_id,bio_version_id,user_id,memory_claim_version_id,created_at
bio_coverage_units|bio_coverage_unit_id,bio_version_id,bio_id,user_id,unit_key,disposition,coverage_policy_version,source_revision,expected_data_epoch,created_at
bio_statements|bio_statement_id,bio_version_id,bio_id,user_id,ordinal,section_key,statement_key,content_purged_at,created_at
bio_validation_findings|bio_validation_finding_id,bio_version_id,bio_id,user_id,bio_statement_id,bio_atomic_proposition_id,severity,disposition,created_at
bio_versions|bio_version_id,bio_id,user_id,revision,status,source_revision,expected_data_epoch,self_entity_id,self_entity_version_id,generation_command_id,writer_model_run_attempt_id,validator_generation_command_id,validator_model_run_attempt_id,content_purged_at,created_at
bios|bio_id,user_id,created_at,updated_at
claim_evidence_links|claim_evidence_link_id,memory_claim_version_id,user_id,evidence_item_id,link_role,status,created_at
claim_retrieval_projections|claim_retrieval_projection_id,user_id,memory_claim_id,memory_claim_version_id,locale,view_direction,projection_policy_version,status,created_at,content_purged_at
compiled_context_revision_refs|compiled_context_id,user_id,conversation_event_revision_id,ordinal,actor,estimated_tokens,sequence_no,section,selection_order
compiled_contexts|compiled_context_id,user_id,generation_command_id,compiler_version,dialogue_revision,source_revision,locale,section_budgets,total_tokens,degraded_reason,created_at,policy_versions,integrity_algorithm,integrity_key_version
continuous_exchange_inactivity_evaluations|inactivity_evaluation_id,user_id,daily_session_id,continuous_exchange_no,policy_version,expected_dialogue_revision,due_at,evaluated_at,outcome,created_at
conversation_action_executions|action_execution_id,user_id,decision_command_id,request_event_revision_id,action_kind,schema_version,catalog_version,target_kind,target_id,target_version_id,daily_session_id,source_revision,expected_data_epoch,idempotency_key,admission_status,execution_status,created_at,resolved_claim_id,resolved_claim_version_id,resolved_qualifier_id,resolved_entity_id,resolved_entity_version_id,resolved_related_entity_id,resolved_related_entity_version_id,entity_identity_operation
conversation_action_handles|compiled_context_id,user_id,generation_command_id,action_kind,target_kind,target_id,target_version_id,source_revision,expected_data_epoch,created_at,expires_at,target_claim_id,target_claim_version_id,target_qualifier_id
conversation_action_payloads|action_execution_id,payload_schema_version,expires_at,content_purged_at
candidate_review_audits|candidate_review_audit_id,user_id,command,disposition,reason,operator_principal_id,policy_version,recorded_at
predicate_change_proposal_candidate_links|predicate_change_proposal_candidate_link_id,user_id,memory_candidate_id,predicate_change_proposal_id,created_at
conversation_action_receipts|action_receipt_id,action_execution_id,receipt_sequence,admission_status,execution_status,disposition,error_code,created_at,receipt_key,resolved_claim_id,resolved_claim_version_id,resolved_qualifier_id,resolved_entity_id,resolved_entity_version_id,resolved_related_entity_id,resolved_related_entity_version_id,entity_identity_operation
conversation_event_revisions|conversation_event_revision_id,user_id,conversation_event_id,revision,locale,transcript_status,created_by,created_at,content_purged_at
conversation_events|conversation_event_id,user_id,daily_session_id,interaction_turn_id,sequence_no,client_event_id,actor,channel,event_type,current_revision_id,lifecycle_status,created_at,deleted_at,generation_command_id
curiosity_stop_signals|curiosity_stop_signal_id,user_id,daily_session_id,version_no,source_revision,policy_version,committed_generation_command_id,created_at
current_curiosity_stop_signals|daily_session_id,curiosity_stop_signal_id,user_id,source_revision,version_no,updated_at
current_dialogue_states|daily_session_id,dialogue_state_version_id,user_id,source_revision,dialogue_revision,covered_through_sequence_no,updated_at
current_rolling_summaries|daily_session_id,rolling_summary_version_id,user_id,covered_through_sequence_no,updated_at
current_safety_postures|daily_session_id,safety_posture_id,user_id,source_revision,version_no,updated_at
daily_session_date_outcomes|daily_session_id,user_id,logical_date,outcome,eligibility_policy_version,source_revision,workflow_receipt_id,computed_at
daily_sessions|daily_session_id,user_id,logical_date,timezone_at_start,started_at,last_activity_at,activity_state,current_continuous_exchange_no,dialogue_revision,source_revision,next_turn_sequence_no,next_event_sequence_no,created_at,updated_at,quiescent_at,quiescent_reason,closure_policy_version
dialogue_state_command_source_refs|dialogue_state_command_id,conversation_event_revision_id,sequence_no
dialogue_state_commands|dialogue_state_command_id,user_id,daily_session_id,expected_data_epoch,source_revision,dialogue_revision,coverage_through_sequence_no,policy_version,prompt_version,model_config_version,status,claimed_at,last_error_code,created_at,claim_id,coverage_key
dialogue_state_versions|dialogue_state_version_id,dialogue_state_command_id,user_id,daily_session_id,version_no,source_revision,dialogue_revision,covered_through_sequence_no,created_at
entities|entity_id,user_id,created_at
entity_clarification_proposals|entity_clarification_proposal_id,user_id,daily_session_id,event_revision_id,entity_mention_id,semantic_impact,status,created_at,decided_at,decided_by_event_revision_id
entity_identity_corrections|entity_identity_correction_id,user_id,action_execution_id,request_event_revision_id,operation,source_entity_id,source_entity_version_id,related_entity_id,related_entity_version_id,created_entity_id,created_entity_version_id,promotion_explicit_statement,promotion_independent_revision_count,correction_policy_version,created_at
entity_identity_revalidation_runs|entity_identity_revalidation_run_id,user_id,workflow_command_id,action_execution_id,source_entity_id,source_entity_version_id,affected_claim_count,affected_journal_statement_count,status,created_at,completed_at
entity_labels|entity_label_id,entity_id,user_id,locale,label_kind,is_current,source_evidence_id,created_at,content_purged_at
entity_mention_candidates|entity_mention_candidate_id,entity_mention_id,user_id,candidate_entity_id,candidate_kind,edit_distance,created_at
entity_mentions|entity_mention_id,user_id,conversation_event_id,event_revision_id,evidence_id,locator_type,start_offset,end_offset,mention_kind,resolved_entity_id,resolution_status,confidence,resolver_policy_version,created_at,content_purged_at
entity_resolve_gate_outcomes|entity_resolve_gate_outcome_id,user_id,entity_mention_id,gate_policy_version,resolver_policy_version,t_auto,verdict,selected_entity_id,confidence,candidate_count,committed,not_committed_reason,created_at
episode_build_runs|episode_build_run_id,user_id,daily_session_id,source_revision,policy_version,expected_data_epoch,generation_command_id,model_run_attempt_id,status,outcome_detail,candidate_count,accepted_count,unresolved_count,rejected_count,error_code,created_at,updated_at
episode_candidate_evidence_links|episode_candidate_evidence_link_id,episode_candidate_id,user_id,evidence_item_id,created_at
episode_candidate_entity_links|episode_candidate_entity_link_id,episode_candidate_id,user_id,entity_id,created_at
episode_candidates|episode_candidate_id,user_id,daily_session_id,source_revision,proposed_episode_kind_id,resolution_status,status,policy_version,generation_command_id,model_run_attempt_id,predecessor_candidate_id,successor_trigger,material_change_reason_codes,reproposal_policy,disposition_policy_version,decided_at,terminal_effective_at,terminal_content_expires_at,created_at,content_purged_at
episode_evidence_links|episode_evidence_link_id,episode_version_id,user_id,evidence_item_id,created_at
episode_impact_reviews|episode_impact_review_id,user_id,episode_version_id,trigger_type,outcome,policy_version,created_at,decided_at
episode_version_entity_links|episode_version_entity_link_id,episode_version_id,user_id,entity_id,created_at
episode_versions|episode_version_id,episode_id,user_id,revision,source_revision,episode_kind_id,status,policy_version,generation_command_id,model_run_attempt_id,supersedes_version_id,enrichment_paused_at,enrichment_pause_reason,created_at,content_purged_at
episodes|episode_id,user_id,status,created_at,deleted_at
entity_versions|entity_version_id,entity_id,user_id,revision,supersedes_version_id,created_at,content_purged_at
evidence_items|evidence_item_id,user_id,evidence_source_snapshot_id,source_event_id,source_revision_id,source_actor,source_status,locator_type,extraction_policy_version,evidence_role,status,created_at
evidence_lineage|evidence_item_id,command_id,attempt_id,created_at
evidence_model_run_attempts|evidence_model_run_attempt_id,evidence_source_snapshot_id,role,provider,model,config_version,extraction_policy_version,prompt_fingerprint,provider_request_id,provider_completed_at,status,created_at
evidence_source_snapshots|evidence_source_snapshot_id,user_id,daily_session_id,source_revision,extraction_policy_version,command_id,attempt_id,champion_config_version,champion_provider,champion_model,champion_provider_policy_version,created_at
fast_path_extraction_runs|fast_path_run_id,user_id,daily_session_id,event_revision_id,event_conversation_event_id,extraction_policy_version,workflow_command_id,model_attempt_id,memory_extract_config_version,memory_extract_model_version,memory_extract_prompt_version,entity_resolve_config_version,role_fallback_used,status,event_committed_at,extracted_at,visibility_lag_ms,visibility_target_met,item_count,mention_count,candidate_count,error_code,created_at,updated_at,retired_at
fast_path_session_items|fast_path_item_id,user_id,daily_session_id,event_revision_id,fast_path_run_id,item_class,memory_candidate_id,entity_mention_id,evidence_item_id,dedupe_key,created_at,retired_at
generation_commands|generation_command_id,user_id,interaction_turn_id,operation_type,intent_key,subject_type,subject_id,input_revision_kind,input_revision_id,prompt_version,product_policy_version,safety_policy_version,relationship_policy_version,locale_policy_version,locale,provider,model,model_snapshot,model_config_version,freshness_policy,expected_data_epoch,status,compiled_context_id,authoritative_result_id,created_at,settled_at,provider_policy_version,consent_policy_version,output_format_version,persona_version,recovery_policy_version,recovery_status,recovery_checked_at,next_recovery_at,harness_policy_version,conversation_action_catalog_version,generation_stage,action_execution_id,action_receipt_sequence,action_execution_status,persona_contract_invariant_version,canonical_persona_version,persona_behavior_anchors_version,model_role,schema_version,role_policy_version,rollout_pin,source_revision,parameter_snapshot,fallback_mode
interaction_turns|interaction_turn_id,user_id,daily_session_id,client_turn_id,turn_sequence_no,continuous_exchange_no,status,retry_of_interaction_turn_id,started_at,settled_at,created_at,updated_at
internal_diagnostic_access_grants|capability,status,step_up_authenticated_at,updated_at
internal_owner_identities|owner_slot,issuer,subject,user_id,active,created_at
journal_diagnostic_findings|journal_diagnostic_finding_id,journal_validation_result_id,journal_version_id,journal_statement_id,code,detail_code,created_at
journal_generation_commands|generation_command_id,user_id,daily_session_id,source_revision,generation_policy_version,expected_data_epoch,created_at,generation_kind,action_execution_id,guidance_expires_at,guidance_content_purged_at
journal_identity_review_fences|journal_identity_review_fence_id,user_id,action_execution_id,journal_statement_id,entity_version_id,source_revision,status,created_at
journal_model_run_attempts|model_run_attempt_id,generation_command_id,role,provider,model,config_version,role_policy_version,prompt_fingerprint,provider_request_id,provider_completed_at,status,created_at
journal_statement_entity_links|journal_statement_entity_link_id,journal_statement_id,entity_version_id,evidence_item_id,user_id,link_role,created_at
journal_statement_evidence_links|journal_statement_id,evidence_item_id,user_id,source_revision,evidence_source_snapshot_id,evidence_role
journal_statements|journal_statement_id,journal_version_id,statement_index,statement_key,user_id,source_revision,evidence_source_snapshot_id
journal_validation_results|journal_validation_result_id,journal_version_id,daily_session_id,source_revision,generation_command_id,model_run_attempt_id,programmatic_valid,status,failure_code,validator_version,created_at,diagnostic_status
journal_versions|journal_version_id,journal_id,user_id,daily_session_id,source_revision,generation_policy_version,validator_version,locale,evidence_source_snapshot_id,status,generation_command_id,model_run_attempt_id,created_at,supersedes_version_id,generation_kind
journal_workflow_outcomes|workflow_command_id,user_id,daily_session_id,source_revision,expected_data_epoch,outcome,reason,created_at
journals|journal_id,user_id,daily_session_id,current_version_id,created_at,deleted_at
memory_candidate_evidence_links|memory_candidate_evidence_link_id,memory_candidate_id,user_id,evidence_item_id,created_at
memory_candidates|memory_candidate_id,user_id,candidate_kind,basis,subject_entity_id,subject_entity_mention_id,object_entity_id,object_entity_mention_id,predicate_id,predicate_registry_version,predicate_resolution_status,mapping_confidence,proposed_valid_from_precision,proposed_valid_to_precision,source_reflection_version_id,generation_command_id,authoritative_model_attempt_id,model_version,prompt_version,extraction_policy_version,status,predicate_review_policy_version,review_eligible_at,review_due_at,registry_release_wait_started_at,registry_release_due_at,disposition_reason_code,disposition_policy_version,decided_at,terminal_effective_at,terminal_content_expires_at,reproposal_policy,predecessor_candidate_id,successor_trigger,material_change_reason_codes,created_at,content_purged_at
memory_claim_corrections|memory_claim_correction_id,user_id,request_event_revision_id,target_claim_id,deactivated_claim_version_id,target_scope,corrected_fact_recorded,correction_policy_version,created_at
memory_claim_version_qualifier_evidence|memory_claim_version_qualifier_evidence_id,memory_claim_version_qualifier_id,user_id,evidence_item_id,created_at
memory_claim_version_qualifiers|memory_claim_version_qualifier_id,memory_claim_version_id,user_id,axis_id,role_side,created_by,created_at,content_purged_at
memory_claim_versions|memory_claim_version_id,memory_claim_id,user_id,revision,kind,epistemic_status,status,confidence,last_observed_at,supersedes_version_id,created_by,model_version,prompt_version,predicate_registry_version,created_at,content_purged_at
memory_claims|memory_claim_id,user_id,created_at,content_purged_at
memory_consolidation_diffs|memory_consolidation_diff_id,memory_consolidation_run_id,user_id,diff_index,diff_kind,memory_candidate_id,memory_claim_id,outcome,reason_code,created_at
memory_consolidation_runs|memory_consolidation_run_id,user_id,consolidation_kind,anchor_date,policy_version,workflow_command_id,expected_data_epoch,model_attempt_id,consolidate_config_version,consolidate_model_version,consolidate_prompt_version,role_fallback_used,status,diff_count,promoted_count,reinforced_count,contested_count,rejected_count,skipped_count,dormant_count,staled_count,purged_count,error_code,created_at,updated_at
memory_correction_followups|memory_correction_followup_id,user_id,workflow_command_id,action_execution_id,target_claim_id,affected_journal_statement_count,followup_policy_version,created_at
memory_forget_evidence_exclusions|memory_forget_evidence_exclusion_id,user_id,memory_forget_request_id,evidence_item_id,exclusion_scope,status,created_at
memory_forget_requests|memory_forget_request_id,user_id,request_event_revision_id,target_claim_id,target_scope,status,applied_claim_version_id,forget_policy_version,created_at,target_qualifier_id
memory_forget_reversals|memory_forget_reversal_id,user_id,memory_forget_request_id,request_event_revision_id,reversal_evidence_id,status,applied_claim_version_id,forget_policy_version,created_at
memory_impression_vetoes|memory_impression_veto_id,user_id,memory_claim_id,vetoed_claim_version_id,request_event_revision_id,status,impression_correction_policy_version,created_at
model_run_attempts|model_run_attempt_id,user_id,generation_command_id,attempt_no,operation_type,provider,model,model_snapshot,prompt_version,status,provider_request_id,started_at,first_token_at,completed_at,input_tokens,output_tokens,cost_micros,finish_reason,error_category,created_at,retry_of_model_run_attempt_id,recovery_status,retry_not_before,recovery_claimed_at,provider_completed_at,attempt_kind,source_attempt_id,provider_egress_event_id,error_code
outbox_events|outbox_event_id,workflow_command_id,aggregate_type,aggregate_id,aggregate_revision,event_type,status,next_attempt_at,lease_owner,lease_expires_at,attempt_count,workflow_receipt_id,last_error_code,payload,created_at,aggregate_coverage,aggregate_data_epoch,cancelled_reason,intent_key
owner_purge_operational_metadata|owner_purge_operational_metadata_id,owner_purge_order_id,user_id,surface_id,operation_type,status,policy_version,provider,role,error_category,attempt_count,recorded_at
owner_purge_orders|owner_purge_order_id,user_id,from_data_epoch,data_epoch,status,confirmation,policy_version,requested_at,access_revoked_at,propagating_at,verifying_at,active_system_deleted_at,retention_pending_at,needs_attention_at,needs_attention_reason,backup_retention_until,last_attempt_at,attempt_count,purge_surface_registry_version,external_integration_manifest_version,workflow_subject_manifest_version
owner_purge_receipts|owner_purge_receipt_id,owner_purge_order_id,destination,destination_disposition,provider_disposition,provider_retention_until,backup_retention_until,recorded_at
provider_egress_consents|user_id,provider,role,consent_policy_version,status,granted_at,revoked_at
provider_egress_dispositions|provider_egress_disposition_id,user_id,model_run_attempt_id,provider,model,role,provider_policy_version,expected_data_epoch,status,error_category,checked_at,dispatched_at,completed_at
relationship_resolver_hints|relationship_resolver_hint_id,user_id,memory_claim_id,memory_claim_version_id,resolved_entity_id,context_entity_id,view_direction,locale,temporal_form,role_side,role_axis_id,role_source,rebuilt_at
retrieval_run_candidates|retrieval_run_candidate_id,retrieval_run_id,user_id,memory_claim_version_id,claim_retrieval_projection_id,retrieval_lane,rank_components,final_rank,selected_section,selection_reason_codes,rejection_reason_codes,created_at
retrieval_runs|retrieval_run_id,user_id,daily_session_id,source_event_revision_id,compiled_context_id,retrieval_policy_version,query_construction_policy_version,projection_policy_version,query_source_refs,lane_plan,deadline_ms,status,degraded_reason_codes,duration_ms,deadline_exceeded_stage,timings,started_at,completed_at
rolling_summary_command_source_refs|rolling_summary_command_id,conversation_event_revision_id,sequence_no
rolling_summary_commands|rolling_summary_command_id,user_id,daily_session_id,expected_data_epoch,source_revision,dialogue_revision,coverage_start_sequence_no,covered_through_sequence_no,policy_version,minimum_uncovered_event_count,minimum_uncovered_token_count,prompt_version,model_config_version,status,claimed_at,last_error_code,created_at
rolling_summary_versions|rolling_summary_version_id,rolling_summary_command_id,user_id,daily_session_id,version_no,covered_through_sequence_no,created_at
safety_posture_alerts|safety_posture_alert_id,user_id,daily_session_id,generation_command_id,policy_version,reason,occurred_at,created_at
safety_postures|safety_posture_id,user_id,daily_session_id,version_no,source_revision,policy_version,committed_generation_command_id,created_at
sensitive_access_audits|sensitive_access_audit_id,user_id,capability,disposition,reason,policy_version,accessed_at
user_self_entities|user_id,entity_id,created_at
workflow_commands|workflow_command_id,command_type,subject_type,subject_id,source_revision,policy_version,expected_data_epoch,status,created_at,dispatched_at,coverage_through_sequence_no,cancelled_reason,action_execution_id,purge_surface_registry_version,external_integration_manifest_version,workflow_subject_manifest_version,intent_key
`.trim().split("\n");

const PURGE_SURFACE_REGISTERED_NON_PRIVATE_COLUMNS = deepFreeze(
  PURGE_SURFACE_REGISTERED_NON_PRIVATE_COLUMN_LINES.flatMap((line) => {
    const [table, fieldList] = line.split("|");
    if (!table || !fieldList) {
      throw new Error(`Invalid purge non-private column manifest line: ${line}`);
    }
    return fieldList.split(",").map((field) => `${table}.${field}`);
  }),
);

/**
 * The only current external integration that receives private owner data is
 * the Responses API provider-egress adapter. Provider retention is a
 * destination concern rather than a local row delete: the clear adapter
 * records the provider retention receipt and the independent verifier rejects
 * an omitted, unknown, or expired-in-an-ambiguous-state destination.
 */
export const PURGE_SURFACE_EXTERNAL_INTEGRATIONS: readonly PurgeSurfaceExternalIntegration[] =
  deepFreeze([
    {
      clearHandler: "record_provider_retention",
      disposition: "retain_owner_envelope",
      integrationId: "provider-egress.responses-api",
      introducedBySchemaOrIntegration: "packages/ai/src/runtime-provider-egress.ts",
      ownerResolution: directUser,
      privateContentFields: ["provider request and response"],
      readDeadlinePolicy: { kind: "none" },
      receiptDestination: "provider:role",
      restoreReapplyHandler: "owner-purge-reapply:v1",
      surfaceKind: "external_integration",
      verifyHandler: "verify_provider_retention_receipt",
    },
  ]);

export const PURGE_SURFACE_REGISTRY_SNAPSHOT: PurgeSurfaceRegistrySnapshot =
  deepFreeze({
    externalIntegrationManifestVersion:
      PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION,
    registeredColumns: PURGE_SURFACE_REGISTERED_COLUMNS,
    nonPrivateColumns: PURGE_SURFACE_REGISTERED_NON_PRIVATE_COLUMNS,
    columnManifestHash: "fnv1a32:5c416805:1216",
    constraintManifestHash: "fnv1a32:e93d1753:635",
    externalIntegrations: PURGE_SURFACE_EXTERNAL_INTEGRATIONS,
    foreignKeyManifestHash: "fnv1a32:086ff5a2:356",
    indexManifestHash: "fnv1a32:897af7de:93",
    registryVersion: PURGE_SURFACE_REGISTRY_VERSION,
    surfaces: PURGE_SURFACE_REGISTRY,
    workflowSubjectManifestVersion: PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION,
  });

export function fingerprintPurgeSurfaceForeignKeys(
  foreignKeys: readonly string[],
): string {
  const canonical = [...foreignKeys].sort().join("\n");
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${foreignKeys.length}`;
}

export function fingerprintPurgeSurfaceColumns(
  columns: readonly string[],
): string {
  const canonical = [...columns].sort().join("\n");
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${columns.length}`;
}

export function fingerprintPurgeSurfaceConstraints(
  constraints: readonly string[],
): string {
  const canonical = [...constraints].sort().join("\n");
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${constraints.length}`;
}

export function normalizePurgeSurfaceIndexDefinition(
  definition: string,
): string {
  const unique = /^\s*CREATE\s+UNIQUE\s+INDEX\b/i.test(definition);
  const tail = definition.match(
    /\bON\s+(?:[a-z][a-z0-9_]*\.)?[a-z][a-z0-9_]*\s*([\s\S]*)$/i,
  )?.[1] ?? definition;
  let normalizedTail = normalizePurgeSurfaceSqlDefinition(
    tail.replace(/;\s*$/, "").replace(/^USING\s+BTREE\s+/i, ""),
  );
  normalizedTail = normalizedTail.replace(
    /\(\(\s*([A-Z][A-Z0-9_]*\s*(?:->>|->|#>>|#>)\s*[^()]*)\s*\)(?=\s*,)/g,
    "($1",
  );
  const whereIndex = normalizedTail.search(/\bWHERE\b/i);
  if (whereIndex >= 0) {
    const prefix = normalizedTail.slice(0, whereIndex).trim();
    const predicate = flattenPurgeSurfaceExpression(
      normalizedTail.slice(whereIndex + "WHERE".length).trim(),
    );
    normalizedTail = `${prefix} WHERE ${predicate}`;
  }
  return `${unique ? "UNIQUE" : "NONUNIQUE"}|${normalizedTail}`;
}

function normalizePurgeSurfaceSqlDefinition(definition: string): string {
  return definition
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(
      /::[A-Z][A-Z0-9_]*(?:\s+WITH\s+TIME\s+ZONE)?/g,
      "",
    )
    .replace(/=\s*ANY\s*\(\s*ARRAY\s*\[/g, "IN (")
    .replace(/(?:<>|!=)\s*ALL\s*\(\s*ARRAY\s*\[/g, "NOT IN (")
    .replace(/\]\s*\)/g, ")")
    .replace(/\bNOT\s+LIKE\b/g, "!~~")
    .replace(/\bLIKE\b/g, "~~")
    .replace(/\s*(->>|->|\?|#>>|#>)\s*/g, " $1 ")
    .replace(/'(-?\d+)'/g, "$1")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenPurgeSurfaceExpression(value: string): string {
  return value
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\bIN\s+([^,\s]+)(?=\s|$)/g, "= $1");
}

export function normalizePurgeSurfaceConstraintDefinition(
  definition: string,
): string {
  const normalized = normalizePurgeSurfaceSqlDefinition(definition);
  const predicate = normalized.match(/\b(CHECK|EXCLUDE)\b[\s\S]*$/)?.[0];
  if (!predicate) {
    return normalized;
  }
  const kind = predicate.startsWith("CHECK") ? "CHECK" : "EXCLUDE";
  const body = predicate.slice(kind.length).trim();
  return kind === "CHECK"
    ? `${kind} ${flattenPurgeSurfaceExpression(body)}`
    : `${kind} ${body}`;
}

export function fingerprintPurgeSurfaceIndexes(
  indexes: readonly Readonly<{
    name: string;
    table: string;
    definition?: string;
  }>[],
): string {
  const canonical = [...indexes]
    .sort((left, right) =>
      `${left.name}|${left.table}`.localeCompare(`${right.name}|${right.table}`),
    )
    .map(
      (index) =>
        `${index.name}|${index.table}|${normalizePurgeSurfaceIndexDefinition(
          index.definition ?? "",
        )}`,
    )
    .join("\n");
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `fnv1a32:${hash.toString(16).padStart(8, "0")}:${indexes.length}`;
}

export class PurgeSurfaceRegistryError extends Error {
  public constructor(public readonly violation: string) {
    super(`Purge Surface Registry is invalid: ${violation}`);
    this.name = "PurgeSurfaceRegistryError";
  }
}

export function assertPurgeSurfaceRegistry(
  registry: PurgeSurfaceRegistrySnapshot = PURGE_SURFACE_REGISTRY_SNAPSHOT,
): PurgeSurfaceRegistrySnapshot {
  if (registry.registryVersion !== PURGE_SURFACE_REGISTRY_VERSION) {
    throw new PurgeSurfaceRegistryError(
      `unknown_registry_version:${registry.registryVersion}`,
    );
  }
  if (
    registry.externalIntegrationManifestVersion !==
    PURGE_EXTERNAL_INTEGRATION_MANIFEST_VERSION
  ) {
    throw new PurgeSurfaceRegistryError(
      `unknown_external_integration_manifest_version:${registry.externalIntegrationManifestVersion}`,
    );
  }
  if (
    registry.workflowSubjectManifestVersion !==
    PURGE_WORKFLOW_SUBJECT_MANIFEST_VERSION
  ) {
    throw new PurgeSurfaceRegistryError(
      `unknown_workflow_subject_manifest_version:${registry.workflowSubjectManifestVersion}`,
    );
  }
  if (registry.foreignKeyManifestHash.trim() === "") {
    throw new PurgeSurfaceRegistryError("blank_foreign_key_manifest_hash");
  }
  if (registry.columnManifestHash.trim() === "") {
    throw new PurgeSurfaceRegistryError("blank_column_manifest_hash");
  }
  if (registry.constraintManifestHash.trim() === "") {
    throw new PurgeSurfaceRegistryError("blank_constraint_manifest_hash");
  }
  if (registry.indexManifestHash.trim() === "") {
    throw new PurgeSurfaceRegistryError("blank_index_manifest_hash");
  }
  if (registry.surfaces.length === 0) {
    throw new PurgeSurfaceRegistryError("empty_surface_registry");
  }
  if (registry.registeredColumns.length === 0) {
    throw new PurgeSurfaceRegistryError("empty_registered_column_manifest");
  }
  if (
    new Set(registry.registeredColumns).size !== registry.registeredColumns.length
  ) {
    throw new PurgeSurfaceRegistryError("duplicate_registered_column");
  }
  if (registry.registeredColumns.some((column) => column.trim() === "")) {
    throw new PurgeSurfaceRegistryError("blank_registered_column");
  }
  if (registry.nonPrivateColumns.length === 0) {
    throw new PurgeSurfaceRegistryError("empty_non_private_column_manifest");
  }
  if (
    new Set(registry.nonPrivateColumns).size !== registry.nonPrivateColumns.length
  ) {
    throw new PurgeSurfaceRegistryError("duplicate_non_private_column");
  }
  if (registry.nonPrivateColumns.some((column) => column.trim() === "")) {
    throw new PurgeSurfaceRegistryError("blank_non_private_column");
  }

  const registeredColumnSet = new Set(registry.registeredColumns);
  const nonPrivateColumnSet = new Set(registry.nonPrivateColumns);
  const privateColumnSet = new Set<string>();
  const ids = new Set<string>();
  const schemaObjects = new Set<string>();
  const clearOrders = new Set<number>();
  for (const surface of registry.surfaces) {
    if (surface.surfaceId.trim() === "") {
      throw new PurgeSurfaceRegistryError("blank_surface_id");
    }
    if (ids.has(surface.surfaceId)) {
      throw new PurgeSurfaceRegistryError(
        `duplicate_surface_id:${surface.surfaceId}`,
      );
    }
    ids.add(surface.surfaceId);
    if (clearOrders.has(surface.clearOrder)) {
      throw new PurgeSurfaceRegistryError(
        `duplicate_clear_order:${surface.clearOrder}`,
      );
    }
    clearOrders.add(surface.clearOrder);
    if (surface.clearHandler === surface.verifyHandler) {
      throw new PurgeSurfaceRegistryError(
        `clear_verify_handler_must_be_independent:${surface.surfaceId}`,
      );
    }
    if (surface.schemaObjects.length === 0) {
      throw new PurgeSurfaceRegistryError(
        `surface_without_schema_object:${surface.surfaceId}`,
      );
    }
    if (surface.privateContentFields.some((field) => field.trim() === "")) {
      throw new PurgeSurfaceRegistryError(
        `blank_private_content_field:${surface.surfaceId}`,
      );
    }
    if (
      new Set(surface.privateContentFields).size !==
      surface.privateContentFields.length
    ) {
      throw new PurgeSurfaceRegistryError(
        `duplicate_private_content_field:${surface.surfaceId}`,
      );
    }
    const table = surface.schemaObjects.find((object) => object.kind === "table")
      ?.name;
    if (!table) {
      throw new PurgeSurfaceRegistryError(
        `surface_without_table_object:${surface.surfaceId}`,
      );
    }
    for (const field of surface.privateContentFields) {
      const qualifiedField = `${table}.${field}`;
      if (!registeredColumnSet.has(qualifiedField)) {
        throw new PurgeSurfaceRegistryError(
          `private_content_field_not_registered:${surface.surfaceId}:${field}`,
        );
      }
      if (nonPrivateColumnSet.has(qualifiedField)) {
        throw new PurgeSurfaceRegistryError(
          `column_classification_conflict:${qualifiedField}`,
        );
      }
      privateColumnSet.add(qualifiedField);
    }
    for (const object of surface.schemaObjects) {
      const key = `${object.kind}:${object.name}`;
      if (schemaObjects.has(key)) {
        throw new PurgeSurfaceRegistryError(`duplicate_schema_object:${key}`);
      }
      schemaObjects.add(key);
    }
    for (const value of [
      surface.clearHandler,
      surface.verifyHandler,
      surface.receiptDestination,
      surface.restoreReapplyHandler,
      surface.introducedBySchemaOrIntegration,
    ]) {
      if (value.trim() === "") {
        throw new PurgeSurfaceRegistryError(
          `blank_contract_field:${surface.surfaceId}`,
        );
      }
    }
    if (
      surface.readDeadlinePolicy.kind === "active_system_deleted_plus_days" &&
      surface.readDeadlinePolicy.days !== 30
    ) {
      throw new PurgeSurfaceRegistryError(
        `unsupported_read_deadline:${surface.surfaceId}`,
      );
    }
  }
  for (const column of registry.nonPrivateColumns) {
    if (!registeredColumnSet.has(column)) {
      throw new PurgeSurfaceRegistryError(
        `non_private_column_not_registered:${column}`,
      );
    }
  }
  for (const column of registry.registeredColumns) {
    if (!privateColumnSet.has(column) && !nonPrivateColumnSet.has(column)) {
      throw new PurgeSurfaceRegistryError(
        `unclassified_registered_column:${column}`,
      );
    }
  }
  for (const integration of registry.externalIntegrations) {
    if (integration.integrationId.trim() === "") {
      throw new PurgeSurfaceRegistryError("blank_integration_id");
    }
    if (ids.has(integration.integrationId)) {
      throw new PurgeSurfaceRegistryError(
        `duplicate_surface_id:${integration.integrationId}`,
      );
    }
    ids.add(integration.integrationId);
    if (
      integration.clearHandler.trim() === "" ||
      integration.verifyHandler.trim() === "" ||
      integration.receiptDestination.trim() === "" ||
      integration.restoreReapplyHandler.trim() === "" ||
      integration.introducedBySchemaOrIntegration.trim() === ""
    ) {
      throw new PurgeSurfaceRegistryError(
        `blank_integration_contract:${integration.integrationId}`,
      );
    }
    if (integration.privateContentFields.some((field) => field.trim() === "")) {
      throw new PurgeSurfaceRegistryError(
        `blank_private_content_field:${integration.integrationId}`,
      );
    }
    if (integration.clearHandler === integration.verifyHandler) {
      throw new PurgeSurfaceRegistryError(
        `clear_verify_handler_must_be_independent:${integration.integrationId}`,
      );
    }
    if (
      integration.readDeadlinePolicy.kind === "active_system_deleted_plus_days" &&
      integration.readDeadlinePolicy.days !== 30
    ) {
      throw new PurgeSurfaceRegistryError(
        `unsupported_read_deadline:${integration.integrationId}`,
      );
    }
  }
  return registry;
}

/**
 * Compare a parsed migration inventory with the closed registry. The parser
 * lives in the release script because the application package must not read
 * the filesystem; this pure comparison is also unit-testable with synthetic
 * migrations and is the gate that rejects an unregistered new table/index.
 */
export function validatePurgeSurfaceInventory(
  inventory: PurgeSurfaceSchemaInventory,
  registry: PurgeSurfaceRegistrySnapshot = PURGE_SURFACE_REGISTRY_SNAPSHOT,
): PurgeSurfaceInventoryValidation {
  assertPurgeSurfaceRegistry(registry);
  const registeredTables = new Set(
    registry.surfaces.flatMap((surface) =>
      surface.schemaObjects
        .filter((object) => object.kind === "table")
        .map((object) => object.name),
    ),
  );
  const registeredIndexes = new Set(
    registry.surfaces.flatMap((surface) =>
      surface.schemaObjects
        .filter((object) => object.kind === "index")
        .map((object) => object.name),
    ),
  );
  const registeredIndexTables = new Map(
    registry.surfaces.flatMap((surface) => {
      const table = surface.schemaObjects.find((object) => object.kind === "table")
        ?.name;
      return table
        ? surface.schemaObjects
            .filter((object) => object.kind === "index")
            .map((object) => [object.name, table] as const)
        : [];
    }),
  );
  const registeredExternalIntegrations = new Set(
    registry.externalIntegrations.map((integration) => integration.integrationId),
  );
  const foreignKeyManifestMismatch =
    fingerprintPurgeSurfaceForeignKeys(inventory.foreignKeys) ===
    registry.foreignKeyManifestHash
      ? null
      : {
          actual: fingerprintPurgeSurfaceForeignKeys(inventory.foreignKeys),
          expected: registry.foreignKeyManifestHash,
        };
  const externalIntegrationManifestVersionMismatch =
    inventory.externalIntegrationManifestVersion ===
    registry.externalIntegrationManifestVersion
      ? null
      : {
          actual: inventory.externalIntegrationManifestVersion ?? null,
          expected: registry.externalIntegrationManifestVersion,
        };
  const columnManifestHash = fingerprintPurgeSurfaceColumns(
    inventory.columns ?? [],
  );
  const columnManifestMismatch =
    columnManifestHash === registry.columnManifestHash
      ? null
      : {
          actual: columnManifestHash,
          expected: registry.columnManifestHash,
        };
  const constraintManifestHash = fingerprintPurgeSurfaceConstraints(
    inventory.constraints ?? [],
  );
  const constraintManifestMismatch =
    constraintManifestHash === registry.constraintManifestHash
      ? null
      : {
          actual: constraintManifestHash,
          expected: registry.constraintManifestHash,
        };
  const indexManifestHash = fingerprintPurgeSurfaceIndexes(inventory.indexes);
  const indexManifestMismatch =
    indexManifestHash === registry.indexManifestHash
      ? null
      : {
          actual: indexManifestHash,
          expected: registry.indexManifestHash,
        };
  const schemaObjects = new Set([
    ...inventory.tables.map((table) => `table:${table}`),
    ...inventory.indexes.map((index) => `index:${index.name}`),
  ]);
  const registeredObjects = new Set([
    ...[...registeredTables].map((table) => `table:${table}`),
    ...[...registeredIndexes].map((index) => `index:${index}`),
  ]);
  const missingTables = inventory.tables.filter(
    (table) => !registeredTables.has(table),
  );
  const missingIndexes = inventory.indexes
    .map((index) => index.name)
    .filter((name) => !registeredIndexes.has(name));
  const inventoryExternalIntegrations = inventory.externalIntegrations ?? [];
  const missingExternalIntegrations = inventoryExternalIntegrations.filter(
    (integration) => !registeredExternalIntegrations.has(integration),
  );
  const registryExternalIntegrationsMissingFromInventory = [
    ...registeredExternalIntegrations,
  ].filter((integration) => !inventoryExternalIntegrations.includes(integration));
  const indexTableMismatches = inventory.indexes
    .filter(
      (index) =>
        registeredIndexTables.has(index.name) &&
        registeredIndexTables.get(index.name) !== index.table,
    )
    .map((index) => ({
      name: index.name,
      registeredTable: registeredIndexTables.get(index.name)!,
      inventoryTable: index.table,
    }));
  const registryObjectsMissingFromSchema = [...registeredObjects].filter(
    (object) => !schemaObjects.has(object),
  );
  const inventoryColumns = new Set(inventory.columns ?? []);
  const registeredColumnSet = new Set(registry.registeredColumns);
  const registryColumnsMissingFromSchema = registry.registeredColumns.filter(
    (column) => !inventoryColumns.has(column),
  );
  const schemaColumnsMissingFromRegistry = [...inventoryColumns].filter(
    (column) => !registeredColumnSet.has(column),
  );
  const ok =
    missingTables.length === 0 &&
    missingIndexes.length === 0 &&
    missingExternalIntegrations.length === 0 &&
    registryExternalIntegrationsMissingFromInventory.length === 0 &&
    indexTableMismatches.length === 0 &&
    foreignKeyManifestMismatch === null &&
    externalIntegrationManifestVersionMismatch === null &&
    columnManifestMismatch === null &&
    constraintManifestMismatch === null &&
    indexManifestMismatch === null &&
    registryColumnsMissingFromSchema.length === 0 &&
    schemaColumnsMissingFromRegistry.length === 0 &&
    registryObjectsMissingFromSchema.length === 0;
  return ok
    ? {
        ok: true,
        registeredIndexes: [...registeredIndexes].sort(),
        registeredTables: [...registeredTables].sort(),
      }
    : {
        ok: false,
        missingExternalIntegrations: [...new Set(missingExternalIntegrations)].sort(),
        missingIndexes: [...new Set(missingIndexes)].sort(),
        missingTables: [...new Set(missingTables)].sort(),
        registryObjectsMissingFromSchema: registryObjectsMissingFromSchema.sort(),
        registryColumnsMissingFromSchema: [
          ...new Set(registryColumnsMissingFromSchema),
        ].sort(),
        schemaColumnsMissingFromRegistry: [
          ...new Set(schemaColumnsMissingFromRegistry),
        ].sort(),
        registryExternalIntegrationsMissingFromInventory: [
          ...new Set(registryExternalIntegrationsMissingFromInventory),
        ].sort(),
        foreignKeyManifestMismatch,
        externalIntegrationManifestVersionMismatch,
        columnManifestMismatch,
        constraintManifestMismatch,
        indexManifestMismatch,
        indexTableMismatches,
      };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

assertPurgeSurfaceRegistry();
