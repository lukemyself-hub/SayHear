CREATE TABLE journal_workflow_outcomes (
  workflow_command_id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('retryable_failed', 'needs_review', 'published')),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (daily_session_id, user_id) REFERENCES daily_sessions(daily_session_id, user_id)
);

CREATE TABLE evidence_model_run_attempts (
  evidence_model_run_attempt_id TEXT PRIMARY KEY,
  evidence_source_snapshot_id UUID
    REFERENCES evidence_source_snapshots(evidence_source_snapshot_id),
  role TEXT NOT NULL CHECK (role = 'evidence.extract'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  config_version TEXT NOT NULL,
  extraction_policy_version TEXT NOT NULL,
  prompt_fingerprint TEXT NOT NULL,
  provider_request_id TEXT,
  provider_completed_at TIMESTAMPTZ,
  result_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX evidence_model_run_attempts_snapshot_idx
  ON evidence_model_run_attempts(evidence_source_snapshot_id)
  WHERE evidence_source_snapshot_id IS NOT NULL;

ALTER TABLE daily_session_date_outcomes
  DROP CONSTRAINT daily_session_date_outcomes_outcome_check,
  ADD CONSTRAINT daily_session_date_outcomes_outcome_check
  CHECK (outcome IN ('no_activity', 'insufficient_expression', 'eligible_queued', 'journal_available'));
