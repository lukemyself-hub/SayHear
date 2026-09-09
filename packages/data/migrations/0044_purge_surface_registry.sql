-- 1A.3b / #194: freeze the executable Purge Surface Registry on every
-- Full Purge order and its driving workflow command. Existing rows retain an
-- explicit legacy provenance marker and are reconciled before any retry.

ALTER TABLE owner_purge_orders
  ADD COLUMN purge_surface_registry_version TEXT NOT NULL
    DEFAULT 'purge-surface-registry:legacy';

ALTER TABLE owner_purge_orders
  ADD COLUMN external_integration_manifest_version TEXT NOT NULL
    DEFAULT 'purge-external-integration-manifest:legacy';

ALTER TABLE owner_purge_orders
  ADD COLUMN workflow_subject_manifest_version TEXT NOT NULL
    DEFAULT 'purge-workflow-subject-manifest:legacy';

ALTER TABLE owner_purge_orders
  ADD CONSTRAINT owner_purge_orders_surface_registry_version_check
  CHECK (purge_surface_registry_version <> '');

ALTER TABLE owner_purge_orders
  ADD CONSTRAINT owner_purge_orders_external_manifest_version_check
  CHECK (external_integration_manifest_version <> '');

ALTER TABLE owner_purge_orders
  ADD CONSTRAINT owner_purge_orders_workflow_subject_manifest_version_check
  CHECK (workflow_subject_manifest_version <> '');

ALTER TABLE workflow_commands
  ADD COLUMN purge_surface_registry_version TEXT;

ALTER TABLE workflow_commands
  ADD COLUMN external_integration_manifest_version TEXT;

ALTER TABLE workflow_commands
  ADD COLUMN workflow_subject_manifest_version TEXT;

UPDATE workflow_commands
SET purge_surface_registry_version = 'purge-surface-registry:legacy'
WHERE command_type = 'owner_full_purge'
  AND purge_surface_registry_version IS NULL;

UPDATE workflow_commands
SET external_integration_manifest_version =
  'purge-external-integration-manifest:legacy'
WHERE command_type = 'owner_full_purge'
  AND external_integration_manifest_version IS NULL;

UPDATE workflow_commands
SET workflow_subject_manifest_version =
  'purge-workflow-subject-manifest:legacy'
WHERE command_type = 'owner_full_purge'
  AND workflow_subject_manifest_version IS NULL;

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_surface_registry_version_shape_check
  CHECK (
    (command_type = 'owner_full_purge') =
    (purge_surface_registry_version IS NOT NULL)
  );

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_external_manifest_version_shape_check
  CHECK (
    (command_type = 'owner_full_purge') =
    (external_integration_manifest_version IS NOT NULL)
  );

ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_workflow_subject_manifest_version_shape_check
  CHECK (
    (command_type = 'owner_full_purge') =
    (workflow_subject_manifest_version IS NOT NULL)
  );

-- Purge orders are retained governance metadata. Normalize any pre-registry
-- free-form reason before enforcing the content-free error-code allowlist.
UPDATE owner_purge_orders
SET needs_attention_reason = 'unknown_error'
WHERE needs_attention_reason IS NOT NULL
  AND needs_attention_reason NOT IN (
    'database_timeout',
    'network_error',
    'unknown_error',
    'verification_failed',
    'purge_marker_missing',
    'purge_marker_epoch_mismatch',
    'purge_marker_invalid',
    'purge_marker_receipts_mismatch',
    'verification_failed:purge_marker_missing',
    'verification_failed:purge_marker_epoch_mismatch',
    'verification_failed:purge_marker_invalid',
    'verification_failed:purge_marker_receipts_mismatch',
    'recovery_reapply_failed',
    'purge_surface_registry_reconciliation_required'
  );

ALTER TABLE owner_purge_orders
  ADD CONSTRAINT owner_purge_orders_needs_attention_reason_check
  CHECK (
    needs_attention_reason IS NULL
    OR needs_attention_reason IN (
      'database_timeout',
      'network_error',
      'unknown_error',
      'verification_failed',
      'purge_marker_missing',
      'purge_marker_epoch_mismatch',
      'purge_marker_invalid',
      'purge_marker_receipts_mismatch',
      'verification_failed:purge_marker_missing',
      'verification_failed:purge_marker_epoch_mismatch',
      'verification_failed:purge_marker_invalid',
      'verification_failed:purge_marker_receipts_mismatch',
      'recovery_reapply_failed',
      'purge_surface_registry_reconciliation_required'
    )
  );

-- Existing in-flight orders were created before the registry and cannot be
-- certified by copying the new version onto them. Park them for a fresh clear
-- and independent verify pass under the current registry; already terminal
-- retention_pending history remains an owner envelope and is not reopened.
UPDATE owner_purge_orders
SET status = 'needs_attention',
    needs_attention_at = COALESCE(needs_attention_at, CURRENT_TIMESTAMP),
    needs_attention_reason = 'purge_surface_registry_reconciliation_required',
    last_attempt_at = COALESCE(last_attempt_at, CURRENT_TIMESTAMP)
WHERE status <> 'retention_pending';

-- Content-free operational metadata survives the active-system deletion
-- boundary for the allowlisted 30-day read window. Source rows are still
-- cleared by their registered adapters; this ledger stores only owner/order
-- lineage, operation state, policy/provider labels and timestamps. It has no
-- payload, domain-object IDs, request IDs, fingerprints or reversible locator.
CREATE TABLE owner_purge_operational_metadata (
  owner_purge_operational_metadata_id UUID PRIMARY KEY,
  owner_purge_order_id UUID NOT NULL
    REFERENCES owner_purge_orders(owner_purge_order_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  surface_id TEXT NOT NULL CHECK (
    surface_id IN (
      'generation_commands',
      'model_run_attempts',
      'workflow_commands',
      'outbox_events',
      'provider_egress_dispositions',
      'daily_session_date_outcomes',
      'continuous_exchange_inactivity_evaluations',
      'journal_workflow_outcomes',
      'journal_generation_commands',
      'journal_model_run_attempts',
      'rolling_summary_commands',
      'dialogue_state_commands',
      'evidence_model_run_attempts',
      'fast_path_extraction_runs',
      'memory_consolidation_runs'
    )
  ),
  operation_type TEXT NOT NULL CHECK (length(operation_type) <= 128),
  status TEXT NOT NULL CHECK (length(status) <= 64),
  policy_version TEXT NOT NULL CHECK (length(policy_version) <= 256),
  provider TEXT NOT NULL CHECK (length(provider) <= 128),
  role TEXT NOT NULL CHECK (length(role) <= 128),
  error_category TEXT NOT NULL CHECK (length(error_category) <= 64),
  attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0),
  recorded_at TIMESTAMPTZ NOT NULL,
  UNIQUE (
    owner_purge_order_id, surface_id, operation_type, status,
    policy_version, provider, role, error_category, attempt_count, recorded_at
  )
);

CREATE INDEX owner_purge_operational_metadata_order_idx
  ON owner_purge_operational_metadata(owner_purge_order_id, recorded_at);

ALTER TABLE owner_purge_receipts
  DROP CONSTRAINT IF EXISTS owner_purge_receipts_destination_disposition_check,
  DROP CONSTRAINT IF EXISTS owner_purge_receipts_provider_disposition_check,
  DROP CONSTRAINT IF EXISTS owner_purge_receipts_destination_check;

ALTER TABLE owner_purge_receipts
  ADD CONSTRAINT owner_purge_receipts_destination_check
  CHECK (
    destination = 'business_database'
    OR destination = 'purge_marker_store'
    OR (
      destination LIKE 'provider:%'
      AND length(destination) > length('provider:')
    )
  );

ALTER TABLE owner_purge_receipts
  ADD CONSTRAINT owner_purge_receipts_destination_disposition_check
  CHECK (
    destination_disposition IN (
      'verified_deleted', 'retention_pending', 'policy_expired',
      'not_applicable', 'unknown'
    )
  ),
  ADD CONSTRAINT owner_purge_receipts_provider_disposition_check
  CHECK (
    provider_disposition IS NULL
    OR provider_disposition IN (
      'retention_pending', 'verified_deleted', 'policy_expired',
      'not_applicable', 'unknown'
    )
  );

-- Inspector audit rows retain only a content-free owner envelope after Full
-- Purge. The target link is private lineage and must be removed; before purge
-- it remains the generation-command target used by the Inspector.
ALTER TABLE sensitive_access_audits
  DROP CONSTRAINT IF EXISTS sensitive_access_audits_target_type_check;

ALTER TABLE sensitive_access_audits
  ALTER COLUMN target_id DROP NOT NULL;

ALTER TABLE sensitive_access_audits
  ADD CONSTRAINT sensitive_access_audits_target_type_check
  CHECK (target_type IN ('generation_command', 'purged_owner'));

ALTER TABLE sensitive_access_audits
  ADD CONSTRAINT sensitive_access_audits_target_shape_check
  CHECK (
    (target_type = 'generation_command' AND target_id IS NOT NULL)
    OR (target_type = 'purged_owner' AND target_id IS NULL)
  );

-- Memory Claim history keeps a content-free lifecycle envelope after Full
-- Purge, not semantic identity. Nullable semantic columns let the purge face
-- remove canonical keys, entity bindings, predicate identity, temporal bounds,
-- and typed values without deleting the immutable row used by epoch fences.
ALTER TABLE memory_claims
  ALTER COLUMN canonical_key DROP NOT NULL,
  ALTER COLUMN subject_entity_id DROP NOT NULL,
  ALTER COLUMN predicate_id DROP NOT NULL,
  ALTER COLUMN scope_key DROP NOT NULL;

ALTER TABLE memory_claims
  DROP CONSTRAINT IF EXISTS memory_claims_canonical_key_check,
  DROP CONSTRAINT IF EXISTS memory_claims_predicate_id_check;

ALTER TABLE memory_claims
  ADD CONSTRAINT memory_claims_canonical_key_shape_check CHECK (
    content_purged_at IS NOT NULL
    OR (canonical_key IS NOT NULL AND canonical_key <> '')
  ),
  ADD CONSTRAINT memory_claims_predicate_shape_check CHECK (
    content_purged_at IS NOT NULL
    OR (predicate_id IS NOT NULL AND predicate_id ~ '^sh\.[a-z_]+\.[a-z_]+$')
  );

ALTER TABLE memory_claim_versions
  ALTER COLUMN subject_entity_version_id DROP NOT NULL,
  ALTER COLUMN temporal_status DROP NOT NULL,
  ALTER COLUMN valid_from_precision DROP NOT NULL,
  ALTER COLUMN valid_to_precision DROP NOT NULL;

DROP TRIGGER IF EXISTS memory_claim_versions_immutable ON memory_claim_versions;

CREATE OR REPLACE FUNCTION enforce_memory_claim_version_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND NEW.memory_claim_version_id = OLD.memory_claim_version_id
    AND NEW.memory_claim_id = OLD.memory_claim_id
    AND NEW.user_id = OLD.user_id
    AND NEW.revision = OLD.revision
    AND NEW.kind = OLD.kind
    AND NEW.epistemic_status = OLD.epistemic_status
    AND NEW.status = OLD.status
    AND NEW.confidence IS NOT DISTINCT FROM OLD.confidence
    AND NEW.last_observed_at = OLD.last_observed_at
    AND NEW.supersedes_version_id IS NOT DISTINCT FROM OLD.supersedes_version_id
    AND NEW.created_by = OLD.created_by
    AND NEW.model_version IS NOT DISTINCT FROM OLD.model_version
    AND NEW.prompt_version IS NOT DISTINCT FROM OLD.prompt_version
    AND NEW.predicate_registry_version = OLD.predicate_registry_version
    AND NEW.created_at = OLD.created_at
    AND NEW.content_purged_at IS NOT NULL
    AND NEW.typed_value IS NULL
    AND NEW.temporal_status IS NULL
    AND NEW.valid_from IS NULL
    AND NEW.valid_from_precision IS NULL
    AND NEW.valid_to IS NULL
    AND NEW.valid_to_precision IS NULL
    AND NEW.subject_entity_version_id IS NULL
    AND NEW.object_entity_version_id IS NULL
    AND (
      OLD.content_purged_at IS NOT NULL
      OR NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at
    )
  THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.content_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'Purged MemoryClaimVersion cannot be un-purged'
      USING ERRCODE = '55000';
  END IF;

  RAISE EXCEPTION 'MemoryClaimVersion is immutable'
    USING ERRCODE = '55000';
END;
$$;

-- Normalize rows left by the earlier typed-value-only purge face before the
-- stronger content-free shape check is installed.
UPDATE memory_claims
SET canonical_key = NULL,
    subject_entity_id = NULL,
    object_entity_id = NULL,
    predicate_id = NULL,
    scope_key = NULL
WHERE content_purged_at IS NOT NULL;

UPDATE memory_claim_versions
SET subject_entity_version_id = NULL,
    object_entity_version_id = NULL,
    typed_value = NULL,
    temporal_status = NULL,
    valid_from = NULL,
    valid_from_precision = NULL,
    valid_to = NULL,
    valid_to_precision = NULL
WHERE content_purged_at IS NOT NULL;

ALTER TABLE memory_claim_versions
  DROP CONSTRAINT IF EXISTS memory_claim_versions_content_shape_check;

ALTER TABLE memory_claim_versions
  ADD CONSTRAINT memory_claim_versions_content_shape_check CHECK (
    (
      content_purged_at IS NULL
      AND typed_value IS NOT NULL
      AND temporal_status IS NOT NULL
      AND valid_from_precision IS NOT NULL
      AND valid_to_precision IS NOT NULL
      AND subject_entity_version_id IS NOT NULL
    )
    OR (
      content_purged_at IS NOT NULL
      AND typed_value IS NULL
      AND temporal_status IS NULL
      AND valid_from IS NULL
      AND valid_from_precision IS NULL
      AND valid_to IS NULL
      AND valid_to_precision IS NULL
      AND subject_entity_version_id IS NULL
      AND object_entity_version_id IS NULL
    )
  );

CREATE TRIGGER memory_claim_versions_immutable
BEFORE UPDATE OR DELETE ON memory_claim_versions
FOR EACH ROW
EXECUTE FUNCTION enforce_memory_claim_version_immutability();
