-- 1A.3b F2 / issue #195.
--
-- This migration adds the shared persistence contract for the seven 1A.3b
-- model roles. It deliberately does not seed a provider, model, or active
-- rollout pin. The role catalog is registered, while production admission
-- remains closed until a release manifest publishes an evaluated config.
--
-- Bio tables are typed read storage only. This issue does not create a
-- BioVersion or a producer. Full Purge remains the owner of deletion
-- orchestration; the application-side F2 purge declaration is kept next to
-- the read schema so F1 can move it into the closed Purge Surface Registry.

CREATE TABLE model_role_definitions (
  role TEXT PRIMARY KEY CHECK (
    role IN (
      'episode.build', 'open_loop.extract', 'reflection.daily',
      'reflection.weekly', 'bio.write', 'narrative.validate',
      'proactive.followup'
    )
  ),
  role_policy_version TEXT NOT NULL CHECK (role_policy_version <> ''),
  freshness_policy TEXT NOT NULL CHECK (
    freshness_policy IN ('source_valid:v1', 'exact_head:v1')
  ),
  tools_mode TEXT NOT NULL CHECK (tools_mode = 'disabled'),
  max_technical_retries SMALLINT NOT NULL
    CHECK (max_technical_retries BETWEEN 0 AND 1),
  max_semantic_repairs SMALLINT NOT NULL
    CHECK (max_semantic_repairs BETWEEN 0 AND 1),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO model_role_definitions (
  role, role_policy_version, freshness_policy, tools_mode,
  max_technical_retries, max_semantic_repairs, enabled, created_at
)
VALUES
  ('episode.build', '1a3b-model-role-policy:v1', 'source_valid:v1', 'disabled', 1, 0, FALSE, CURRENT_TIMESTAMP),
  ('open_loop.extract', '1a3b-model-role-policy:v1', 'source_valid:v1', 'disabled', 1, 0, FALSE, CURRENT_TIMESTAMP),
  ('reflection.daily', '1a3b-model-role-policy:v1', 'exact_head:v1', 'disabled', 1, 0, FALSE, CURRENT_TIMESTAMP),
  ('reflection.weekly', '1a3b-model-role-policy:v1', 'exact_head:v1', 'disabled', 1, 0, FALSE, CURRENT_TIMESTAMP),
  ('bio.write', '1a3b-model-role-policy:v1', 'exact_head:v1', 'disabled', 1, 1, FALSE, CURRENT_TIMESTAMP),
  ('narrative.validate', '1a3b-model-role-policy:v1', 'exact_head:v1', 'disabled', 1, 0, FALSE, CURRENT_TIMESTAMP),
  ('proactive.followup', '1a3b-model-role-policy:v1', 'exact_head:v1', 'disabled', 0, 0, FALSE, CURRENT_TIMESTAMP);

CREATE TABLE model_role_configurations (
  role TEXT NOT NULL REFERENCES model_role_definitions(role),
  config_version TEXT NOT NULL CHECK (config_version <> ''),
  provider TEXT NOT NULL CHECK (provider <> ''),
  model TEXT NOT NULL CHECK (model <> ''),
  model_snapshot TEXT NOT NULL CHECK (model_snapshot <> ''),
  prompt_version TEXT NOT NULL CHECK (prompt_version <> ''),
  schema_version TEXT NOT NULL CHECK (schema_version <> ''),
  role_policy_version TEXT NOT NULL CHECK (role_policy_version <> ''),
  provider_policy_version TEXT NOT NULL
    REFERENCES provider_egress_policy_versions(policy_version),
  freshness_policy TEXT NOT NULL
    CHECK (freshness_policy IN ('source_valid:v1', 'exact_head:v1')),
  fallback_mode TEXT NOT NULL CHECK (fallback_mode = 'disabled'),
  max_technical_retries SMALLINT NOT NULL
    CHECK (max_technical_retries BETWEEN 0 AND 1),
  max_semantic_repairs SMALLINT NOT NULL
    CHECK (max_semantic_repairs BETWEEN 0 AND 1),
  parameter_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(parameter_snapshot) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (role, config_version),
  UNIQUE (role, config_version, provider_policy_version)
);

CREATE TABLE model_role_rollout_pins (
  role TEXT NOT NULL,
  rollout_pin TEXT NOT NULL CHECK (rollout_pin <> ''),
  config_version TEXT NOT NULL,
  provider_policy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  activated_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (role, rollout_pin),
  FOREIGN KEY (role, config_version, provider_policy_version)
    REFERENCES model_role_configurations(
      role, config_version, provider_policy_version
    ),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX model_role_rollout_pins_one_active_idx
  ON model_role_rollout_pins(role)
  WHERE status = 'active';

-- The shared command tables previously enforced the conversation-only shape.
-- Keep conversation validation in a trigger while allowing non-conversation
-- roles to use the same durable command and attempt ledgers.
ALTER TABLE provider_egress_policy_versions
  DROP CONSTRAINT IF EXISTS provider_egress_policy_versions_role_check;
ALTER TABLE provider_egress_policy_versions
  ADD CONSTRAINT provider_egress_policy_versions_role_check
  CHECK (
    role IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  );

ALTER TABLE provider_egress_consents
  DROP CONSTRAINT IF EXISTS provider_egress_consents_role_check;
ALTER TABLE provider_egress_consents
  ADD CONSTRAINT provider_egress_consents_role_check
  CHECK (
    role IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  );

ALTER TABLE provider_egress_dispositions
  DROP CONSTRAINT IF EXISTS provider_egress_dispositions_role_check;
ALTER TABLE provider_egress_dispositions
  ADD CONSTRAINT provider_egress_dispositions_role_check
  CHECK (
    role IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  );

ALTER TABLE generation_commands
  ADD COLUMN model_role TEXT NOT NULL DEFAULT 'conversation.text',
  ADD COLUMN schema_version TEXT NOT NULL DEFAULT 'conversation.text:v1',
  ADD COLUMN role_policy_version TEXT NOT NULL DEFAULT 'conversation.text:v1',
  ADD COLUMN rollout_pin TEXT NOT NULL DEFAULT 'legacy:conversation.text',
  ADD COLUMN source_revision BIGINT,
  ADD COLUMN source_snapshot TEXT,
  ADD COLUMN input_manifest JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN parameter_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN fallback_mode TEXT NOT NULL DEFAULT 'disabled';

ALTER TABLE generation_commands
  ALTER COLUMN interaction_turn_id DROP NOT NULL,
  ALTER COLUMN input_revision_kind DROP NOT NULL,
  ALTER COLUMN input_revision_id DROP NOT NULL;

ALTER TABLE generation_commands
  DROP CONSTRAINT IF EXISTS generation_commands_operation_type_check,
  DROP CONSTRAINT IF EXISTS generation_commands_subject_type_check,
  DROP CONSTRAINT IF EXISTS generation_commands_input_revision_kind_check,
  DROP CONSTRAINT IF EXISTS generation_commands_freshness_policy_check,
  DROP CONSTRAINT IF EXISTS generation_commands_subject_id_user_id_fkey,
  DROP CONSTRAINT IF EXISTS generation_commands_input_revision_id_subject_id_user_id_fkey;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_operation_type_check
  CHECK (
    operation_type IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  ),
  ADD CONSTRAINT generation_commands_subject_type_check
  CHECK (
    subject_type IN (
      'conversation_event', 'app_user', 'daily_session', 'entity',
      'memory_claim', 'conversation_event_revision', 'bio', 'bio_version',
      'reflection', 'episode', 'open_loop'
    )
  ),
  ADD CONSTRAINT generation_commands_model_role_check
  CHECK (
    model_role IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  ),
  ADD CONSTRAINT generation_commands_model_role_operation_check
  CHECK (model_role = operation_type),
  ADD CONSTRAINT generation_commands_source_revision_check
  CHECK (source_revision IS NULL OR source_revision >= 0),
  ADD CONSTRAINT generation_commands_input_manifest_object_check
  CHECK (jsonb_typeof(input_manifest) = 'object'),
  ADD CONSTRAINT generation_commands_parameter_snapshot_object_check
  CHECK (jsonb_typeof(parameter_snapshot) = 'object'),
  ADD CONSTRAINT generation_commands_fallback_mode_check
  CHECK (fallback_mode = 'disabled'),
  ADD CONSTRAINT generation_commands_conversation_shape_check
  CHECK (
    operation_type <> 'conversation.text'
    OR (
      interaction_turn_id IS NOT NULL
      AND input_revision_kind = 'conversation_event_revision'
      AND input_revision_id IS NOT NULL
    )
  );

CREATE FUNCTION enforce_generation_command_conversation_owner_fence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.operation_type = 'conversation.text' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM conversation_events event
      WHERE event.conversation_event_id = NEW.subject_id
        AND event.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'Conversation GenerationCommand subject crossed owner boundary'
        USING ERRCODE = '23503';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM conversation_event_revisions revision
      WHERE revision.conversation_event_revision_id = NEW.input_revision_id
        AND revision.conversation_event_id = NEW.subject_id
        AND revision.user_id = NEW.user_id
    ) THEN
      RAISE EXCEPTION 'Conversation GenerationCommand input revision is invalid'
        USING ERRCODE = '23503';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER generation_commands_conversation_owner_fence
BEFORE INSERT OR UPDATE ON generation_commands
FOR EACH ROW
EXECUTE FUNCTION enforce_generation_command_conversation_owner_fence();

ALTER TABLE model_run_attempts
  ADD COLUMN attempt_kind TEXT NOT NULL DEFAULT 'initial',
  ADD COLUMN source_attempt_id UUID,
  ADD COLUMN provider_egress_event_id TEXT,
  ADD COLUMN error_code TEXT;

ALTER TABLE model_run_attempts
  DROP CONSTRAINT IF EXISTS model_run_attempts_operation_type_check;
ALTER TABLE model_run_attempts
  DROP CONSTRAINT IF EXISTS model_run_attempts_status_check;
ALTER TABLE model_run_attempts
  ADD CONSTRAINT model_run_attempts_operation_type_check
  CHECK (
    operation_type IN (
      'conversation.text', 'episode.build', 'open_loop.extract',
      'reflection.daily', 'reflection.weekly', 'bio.write',
      'narrative.validate', 'proactive.followup'
    )
  ),
  ADD CONSTRAINT model_run_attempts_status_check
  CHECK (
    status IN (
      'prepared', 'running', 'succeeded', 'failed', 'interrupted',
      'result_unknown', 'discarded'
    )
  ),
  ADD CONSTRAINT model_run_attempts_attempt_kind_check
  CHECK (attempt_kind IN ('initial', 'technical_retry', 'schema_repair'));

-- The existing workflow/outbox is also the durable recovery seam for F2. The
-- intent key is content-free and keeps different input snapshots from being
-- absorbed by the older aggregate-only idempotency key.
ALTER TABLE workflow_commands
  ADD COLUMN intent_key TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check,
  DROP CONSTRAINT IF EXISTS workflow_commands_subject_type_check,
  DROP CONSTRAINT IF EXISTS workflow_commands_revision_coverage_key;
ALTER TABLE workflow_commands
  ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (
    command_type IN (
      'journal_eligibility', 'rolling_summary', 'dialogue_state',
      'journal_regeneration', 'owner_full_purge', 'fast_path_extraction',
      'daily_consolidation', 'weekly_consolidation', 'memory_sweeper',
      'memory_correction_followup', 'entity_identity_revalidation',
      'model_role'
    )
  ),
  ADD CONSTRAINT workflow_commands_subject_type_check
  CHECK (
    subject_type IN (
      'daily_session', 'app_user', 'entity', 'memory_claim',
      'conversation_event_revision'
    )
  ),
  ADD CONSTRAINT workflow_commands_revision_coverage_key
  UNIQUE (
    command_type, subject_type, subject_id, source_revision,
    expected_data_epoch, policy_version, coverage_through_sequence_no,
    intent_key
  );

ALTER TABLE outbox_events
  ADD COLUMN intent_key TEXT NOT NULL DEFAULT '';
ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check;
ALTER TABLE outbox_events
  ADD CONSTRAINT outbox_events_event_type_check
  CHECK (
    event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'journal_regeneration_requested',
      'owner_full_purge_requested', 'fast_path_extraction_requested',
      'daily_consolidation_requested', 'weekly_consolidation_requested',
      'memory_sweeper_requested', 'memory_correction_followup_requested',
      'entity_identity_revalidation_requested', 'model_role_requested'
    )
  );

DROP INDEX IF EXISTS outbox_events_one_per_aggregate_event_idx;
CREATE UNIQUE INDEX outbox_events_one_per_aggregate_event_idx
  ON outbox_events(
    aggregate_type,
    aggregate_id,
    aggregate_revision,
    aggregate_data_epoch,
    aggregate_coverage,
    event_type,
    intent_key,
    COALESCE(payload->>'policyVersion', '')
  );

-- Typed Bio read schema. No producer is installed by this migration and no
-- BioVersion is created during deployment.
CREATE TABLE bios (
  bio_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  current_version_id UUID,
  current_source_revision BIGINT,
  current_data_epoch BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bio_id, user_id),
  CHECK (current_source_revision IS NULL OR current_source_revision >= 0),
  CHECK (current_data_epoch IS NULL OR current_data_epoch > 0)
);

CREATE TABLE bio_versions (
  bio_version_id UUID PRIMARY KEY,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft', 'validated', 'published', 'superseded', 'trust_invalidated',
      'stale', 'needs_review', 'content_expired'
    )
  ),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  source_manifest JSONB NOT NULL CHECK (jsonb_typeof(source_manifest) = 'object'),
  presentation_locale TEXT NOT NULL CHECK (presentation_locale <> ''),
  self_entity_id UUID,
  self_entity_version_id UUID,
  generation_command_id UUID,
  writer_model_run_attempt_id UUID,
  validator_generation_command_id UUID,
  validator_model_run_attempt_id UUID,
  content_expires_at TIMESTAMPTZ,
  content_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bio_id, revision),
  UNIQUE (bio_version_id, bio_id, user_id),
  FOREIGN KEY (bio_id, user_id) REFERENCES bios(bio_id, user_id),
  CHECK (
    status <> 'published'
    OR (validator_generation_command_id IS NOT NULL AND validator_model_run_attempt_id IS NOT NULL)
  )
);

ALTER TABLE bios
  ADD CONSTRAINT bios_current_version_fk
  FOREIGN KEY (current_version_id, bio_id, user_id)
  REFERENCES bio_versions(bio_version_id, bio_id, user_id);

CREATE UNIQUE INDEX bios_one_current_version_idx
  ON bios(current_version_id)
  WHERE current_version_id IS NOT NULL;

CREATE TABLE bio_statements (
  bio_statement_id UUID PRIMARY KEY,
  bio_version_id UUID NOT NULL,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  section_key TEXT NOT NULL CHECK (section_key <> ''),
  statement_key TEXT NOT NULL CHECK (statement_key <> ''),
  statement_text TEXT,
  content_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bio_statement_id, bio_version_id, user_id),
  UNIQUE (bio_version_id, ordinal),
  FOREIGN KEY (bio_version_id, bio_id, user_id)
    REFERENCES bio_versions(bio_version_id, bio_id, user_id),
  CHECK (statement_text IS NOT NULL OR content_purged_at IS NOT NULL)
);

CREATE TABLE bio_atomic_propositions (
  bio_atomic_proposition_id UUID PRIMARY KEY,
  bio_version_id UUID NOT NULL,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  proposition_key TEXT NOT NULL CHECK (proposition_key <> ''),
  proposition_text TEXT,
  content_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (bio_atomic_proposition_id, bio_version_id, user_id),
  UNIQUE (bio_version_id, proposition_key),
  FOREIGN KEY (bio_version_id, bio_id, user_id)
    REFERENCES bio_versions(bio_version_id, bio_id, user_id),
  CHECK (proposition_text IS NOT NULL OR content_purged_at IS NOT NULL)
);

CREATE TABLE bio_claim_links (
  bio_claim_link_id UUID PRIMARY KEY,
  bio_version_id UUID NOT NULL,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_version_id UUID NOT NULL,
  link_role TEXT NOT NULL CHECK (link_role IN ('input', 'support')),
  support_status TEXT NOT NULL CHECK (
    support_status IN ('eligible', 'deferred_by_budget', 'invalidated', 'missing')
  ),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (bio_version_id, bio_id, user_id)
    REFERENCES bio_versions(bio_version_id, bio_id, user_id),
  UNIQUE (bio_version_id, memory_claim_version_id, link_role)
);

CREATE TABLE bio_coverage_units (
  bio_coverage_unit_id UUID PRIMARY KEY,
  bio_version_id UUID NOT NULL,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  unit_key TEXT NOT NULL CHECK (unit_key <> ''),
  disposition TEXT NOT NULL CHECK (
    disposition IN (
      'covered', 'deferred_by_budget', 'background_absent',
      'excluded_by_policy', 'stale'
    )
  ),
  coverage_policy_version TEXT NOT NULL CHECK (coverage_policy_version <> ''),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (bio_version_id, bio_id, user_id)
    REFERENCES bio_versions(bio_version_id, bio_id, user_id),
  UNIQUE (bio_version_id, unit_key),
  UNIQUE (bio_coverage_unit_id, bio_version_id, user_id)
);

CREATE TABLE bio_coverage_members (
  bio_coverage_unit_id UUID NOT NULL,
  bio_version_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  memory_claim_version_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bio_coverage_unit_id, memory_claim_version_id),
  FOREIGN KEY (bio_coverage_unit_id, bio_version_id, user_id)
    REFERENCES bio_coverage_units(
      bio_coverage_unit_id, bio_version_id, user_id
    )
);

CREATE TABLE bio_validation_findings (
  bio_validation_finding_id UUID PRIMARY KEY,
  bio_version_id UUID NOT NULL,
  bio_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  bio_statement_id UUID,
  bio_atomic_proposition_id UUID,
  finding_code TEXT NOT NULL CHECK (finding_code <> ''),
  severity TEXT NOT NULL CHECK (severity IN ('error', 'warning')),
  disposition TEXT NOT NULL CHECK (
    disposition IN ('open', 'accepted', 'repaired', 'superseded')
  ),
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (bio_version_id, bio_id, user_id)
    REFERENCES bio_versions(bio_version_id, bio_id, user_id),
  FOREIGN KEY (bio_statement_id, bio_version_id, user_id)
    REFERENCES bio_statements(bio_statement_id, bio_version_id, user_id),
  FOREIGN KEY (bio_atomic_proposition_id, bio_version_id, user_id)
    REFERENCES bio_atomic_propositions(
      bio_atomic_proposition_id, bio_version_id, user_id
    )
);

CREATE INDEX bio_versions_owner_status_idx
  ON bio_versions(user_id, status, source_revision);
CREATE INDEX bio_claim_links_owner_version_idx
  ON bio_claim_links(user_id, bio_version_id, link_role);
CREATE INDEX bio_coverage_units_owner_version_idx
  ON bio_coverage_units(user_id, bio_version_id, disposition);
