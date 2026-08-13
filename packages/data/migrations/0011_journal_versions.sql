-- 1A.2 / issue #20: immutable evidence-backed Journal artifacts.
CREATE TABLE journal_generation_commands (
  generation_command_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  generation_policy_version TEXT NOT NULL,
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, daily_session_id, source_revision, generation_policy_version)
);

CREATE TABLE journal_model_run_attempts (
  model_run_attempt_id TEXT PRIMARY KEY,
  generation_command_id TEXT NOT NULL REFERENCES journal_generation_commands(generation_command_id),
  role TEXT NOT NULL DEFAULT 'journal.draft',
  provider TEXT NOT NULL DEFAULT 'deterministic',
  model TEXT NOT NULL DEFAULT 'unknown',
  config_version TEXT NOT NULL DEFAULT 'unknown',
  role_policy_version TEXT NOT NULL DEFAULT 'unknown',
  prompt_fingerprint TEXT NOT NULL DEFAULT 'unknown',
  provider_request_id TEXT,
  provider_completed_at TIMESTAMPTZ,
  result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL
  ,UNIQUE (generation_command_id, model_run_attempt_id)
);

CREATE TABLE journals (
  journal_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL UNIQUE REFERENCES daily_sessions(daily_session_id),
  current_version_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id)
);

CREATE TABLE journal_versions (
  journal_version_id UUID PRIMARY KEY,
  journal_id UUID NOT NULL REFERENCES journals(journal_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  generation_policy_version TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  evidence_source_snapshot_id UUID NOT NULL REFERENCES evidence_source_snapshots(evidence_source_snapshot_id),
  status TEXT NOT NULL CHECK (status IN ('published', 'stale', 'validation_failed', 'needs_review')),
  generation_command_id TEXT NOT NULL,
  model_run_attempt_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (journal_id, source_revision, generation_policy_version),
  UNIQUE (user_id, daily_session_id, source_revision, generation_policy_version),
  UNIQUE (journal_version_id, user_id, source_revision, evidence_source_snapshot_id),
  FOREIGN KEY (generation_command_id) REFERENCES journal_generation_commands(generation_command_id),
  FOREIGN KEY (model_run_attempt_id) REFERENCES journal_model_run_attempts(model_run_attempt_id),
  FOREIGN KEY (generation_command_id, model_run_attempt_id)
    REFERENCES journal_model_run_attempts(generation_command_id, model_run_attempt_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id)
);

ALTER TABLE journals
  ADD CONSTRAINT journals_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES journal_versions(journal_version_id);

CREATE TABLE journal_statements (
  journal_statement_id UUID PRIMARY KEY,
  journal_version_id UUID NOT NULL REFERENCES journal_versions(journal_version_id),
  statement_index INTEGER NOT NULL CHECK (statement_index >= 0),
  statement_key TEXT NOT NULL,
  statement_text TEXT NOT NULL CHECK (BTRIM(statement_text) <> ''),
  epistemic_status TEXT NOT NULL CHECK (epistemic_status IN ('supported_expression', 'inferred_observation')),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  evidence_source_snapshot_id UUID NOT NULL REFERENCES evidence_source_snapshots(evidence_source_snapshot_id),
  UNIQUE (journal_version_id, statement_index),
  UNIQUE (journal_version_id, statement_key),
  UNIQUE (journal_statement_id, user_id, source_revision),
  UNIQUE (journal_version_id, user_id, source_revision, evidence_source_snapshot_id),
  FOREIGN KEY (journal_version_id, user_id, source_revision, evidence_source_snapshot_id)
    REFERENCES journal_versions(journal_version_id, user_id, source_revision, evidence_source_snapshot_id)
);

CREATE TABLE journal_statement_evidence_links (
  journal_statement_id UUID NOT NULL REFERENCES journal_statements(journal_statement_id),
  evidence_item_id UUID NOT NULL REFERENCES evidence_items(evidence_item_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  evidence_source_snapshot_id UUID NOT NULL REFERENCES evidence_source_snapshots(evidence_source_snapshot_id),
  evidence_role TEXT NOT NULL CHECK (evidence_role IN ('factual_support', 'subjective_report')),
  PRIMARY KEY (journal_statement_id, evidence_item_id),
  FOREIGN KEY (journal_statement_id, user_id, source_revision)
    REFERENCES journal_statements(journal_statement_id, user_id, source_revision),
  FOREIGN KEY (evidence_item_id, user_id, evidence_source_snapshot_id)
    REFERENCES evidence_items(evidence_item_id, user_id, evidence_source_snapshot_id)
);

CREATE TABLE journal_validation_results (
  journal_validation_result_id UUID PRIMARY KEY,
  journal_version_id UUID REFERENCES journal_versions(journal_version_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  generation_command_id TEXT NOT NULL,
  model_run_attempt_id TEXT NOT NULL,
  programmatic_valid BOOLEAN NOT NULL,
  model_valid BOOLEAN NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('validated', 'validation_failed', 'needs_review')),
  failure_code TEXT,
  validator_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, source_revision, generation_command_id, failure_code, status),
  FOREIGN KEY (generation_command_id) REFERENCES journal_generation_commands(generation_command_id),
  FOREIGN KEY (model_run_attempt_id) REFERENCES journal_model_run_attempts(model_run_attempt_id),
  FOREIGN KEY (generation_command_id, model_run_attempt_id)
    REFERENCES journal_model_run_attempts(generation_command_id, model_run_attempt_id)
);

CREATE FUNCTION reject_journal_artifact_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Published Journal artifacts are immutable' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER journal_versions_immutable BEFORE UPDATE OR DELETE ON journal_versions
FOR EACH ROW EXECUTE FUNCTION reject_journal_artifact_mutation();
CREATE TRIGGER journal_statements_immutable BEFORE UPDATE OR DELETE ON journal_statements
FOR EACH ROW EXECUTE FUNCTION reject_journal_artifact_mutation();
CREATE TRIGGER journal_statement_evidence_links_immutable BEFORE UPDATE OR DELETE ON journal_statement_evidence_links
FOR EACH ROW EXECUTE FUNCTION reject_journal_artifact_mutation();
CREATE TRIGGER journal_validation_results_immutable BEFORE UPDATE OR DELETE ON journal_validation_results
FOR EACH ROW EXECUTE FUNCTION reject_journal_artifact_mutation();
