-- Issue #25: admit the first typed Conversation Action without allowing the
-- Action audit envelope or outbox to become a second copy of user content.

ALTER TABLE workflow_commands
  DROP CONSTRAINT IF EXISTS workflow_commands_command_type_check,
  ADD CONSTRAINT workflow_commands_command_type_check
    CHECK (command_type IN ('journal_eligibility', 'rolling_summary', 'dialogue_state', 'journal_regeneration'));

ALTER TABLE outbox_events
  DROP CONSTRAINT IF EXISTS outbox_events_event_type_check,
  ADD CONSTRAINT outbox_events_event_type_check
    CHECK (event_type IN (
      'journal_eligibility_requested', 'rolling_summary_requested',
      'dialogue_state_requested', 'journal_regeneration_requested'
    ));

ALTER TABLE journal_generation_commands
  ADD COLUMN generation_kind TEXT NOT NULL DEFAULT 'automatic'
    CHECK (generation_kind IN ('automatic', 'regeneration')),
  ADD COLUMN action_execution_id UUID,
  ADD COLUMN guidance_ciphertext BYTEA,
  ADD COLUMN guidance_expires_at TIMESTAMPTZ,
  ADD COLUMN guidance_content_purged_at TIMESTAMPTZ;

ALTER TABLE journal_generation_commands
  DROP CONSTRAINT IF EXISTS journal_generation_commands_user_id_daily_session_id_source_revision_generation_policy_version_key,
  DROP CONSTRAINT IF EXISTS journal_generation_commands_user_id_daily_session_id_source_key;

CREATE UNIQUE INDEX journal_generation_commands_automatic_identity_idx
  ON journal_generation_commands(user_id, daily_session_id, source_revision, generation_policy_version)
  WHERE generation_kind = 'automatic';

CREATE UNIQUE INDEX journal_generation_commands_action_execution_idx
  ON journal_generation_commands(action_execution_id)
  WHERE action_execution_id IS NOT NULL;

ALTER TABLE journal_versions
  ADD COLUMN generation_kind TEXT NOT NULL DEFAULT 'automatic'
    CHECK (generation_kind IN ('automatic', 'regeneration'));

ALTER TABLE journal_versions
  DROP CONSTRAINT IF EXISTS journal_versions_journal_id_source_revision_generation_policy_version_key,
  DROP CONSTRAINT IF EXISTS journal_versions_journal_id_source_revision_generation_poli_key,
  DROP CONSTRAINT IF EXISTS journal_versions_user_id_daily_session_id_source_revision_generation_policy_version_key,
  DROP CONSTRAINT IF EXISTS journal_versions_user_id_daily_session_id_source_revision_g_key;

CREATE UNIQUE INDEX journal_versions_automatic_identity_idx
  ON journal_versions(journal_id, source_revision, generation_policy_version)
  WHERE generation_kind = 'automatic';

CREATE UNIQUE INDEX journal_versions_command_identity_idx
  ON journal_versions(journal_id, generation_command_id);

CREATE TABLE conversation_action_handles (
  handle TEXT PRIMARY KEY,
  compiled_context_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  generation_command_id UUID NOT NULL,
  action_kind TEXT NOT NULL CHECK (action_kind = 'regenerate_journal'),
  target_kind TEXT NOT NULL CHECK (target_kind = 'journal'),
  target_id UUID NOT NULL REFERENCES journals(journal_id),
  target_version_id UUID NOT NULL REFERENCES journal_versions(journal_version_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE (handle, user_id),
  FOREIGN KEY (compiled_context_id, user_id)
    REFERENCES compiled_contexts(compiled_context_id, user_id),
  FOREIGN KEY (generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id)
);

CREATE INDEX conversation_action_handles_lookup_idx
  ON conversation_action_handles(user_id, generation_command_id, action_kind, expires_at);

CREATE TABLE conversation_action_executions (
  action_execution_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  decision_command_id UUID NOT NULL,
  request_event_revision_id UUID NOT NULL,
  action_kind TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  target_handle TEXT,
  target_kind TEXT CHECK (target_kind IS NULL OR target_kind = 'journal'),
  target_id UUID REFERENCES journals(journal_id),
  target_version_id UUID REFERENCES journal_versions(journal_version_id),
  daily_session_id UUID REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT CHECK (source_revision >= 0),
  expected_data_epoch BIGINT CHECK (expected_data_epoch > 0),
  idempotency_key TEXT NOT NULL,
  admission_status TEXT NOT NULL
    CHECK (admission_status IN ('accepted', 'clarification_required', 'rejected', 'unsupported')),
  execution_status TEXT NOT NULL
    CHECK (execution_status IN ('not_started', 'pending', 'running', 'succeeded', 'failed', 'canceled')),
  disposition TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, idempotency_key),
  UNIQUE (decision_command_id, action_kind, target_handle),
  FOREIGN KEY (decision_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id),
  FOREIGN KEY (request_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(conversation_event_revision_id, user_id)
);

CREATE INDEX conversation_action_in_flight_target_idx
  ON conversation_action_executions(user_id, target_id, execution_status)
  WHERE execution_status IN ('pending', 'running');

CREATE TABLE conversation_action_receipts (
  action_receipt_id UUID PRIMARY KEY,
  action_execution_id UUID NOT NULL REFERENCES conversation_action_executions(action_execution_id),
  receipt_sequence INTEGER NOT NULL CHECK (receipt_sequence > 0),
  admission_status TEXT NOT NULL
    CHECK (admission_status IN ('accepted', 'clarification_required', 'rejected', 'unsupported')),
  execution_status TEXT NOT NULL
    CHECK (execution_status IN ('not_started', 'pending', 'running', 'succeeded', 'failed', 'canceled')),
  disposition TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (action_execution_id, receipt_sequence)
);

CREATE TABLE conversation_action_payloads (
  action_execution_id UUID PRIMARY KEY REFERENCES conversation_action_executions(action_execution_id),
  payload_schema_version TEXT NOT NULL,
  ciphertext BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ
);

ALTER TABLE journal_generation_commands
  ADD CONSTRAINT journal_generation_commands_action_execution_fk
    FOREIGN KEY (action_execution_id)
    REFERENCES conversation_action_executions(action_execution_id);
