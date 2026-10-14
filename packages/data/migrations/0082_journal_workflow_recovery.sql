ALTER TABLE journal_workflow_outcomes
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN next_attempt_at TIMESTAMPTZ,
  ADD COLUMN lease_token TEXT,
  ADD COLUMN lease_expires_at TIMESTAMPTZ;

ALTER TABLE evidence_model_run_attempts
  ADD COLUMN user_id UUID REFERENCES app_users(user_id),
  ADD COLUMN daily_session_id UUID REFERENCES daily_sessions(daily_session_id),
  ADD COLUMN source_revision BIGINT,
  ADD COLUMN expected_data_epoch BIGINT;

UPDATE evidence_model_run_attempts attempt SET user_id = snapshot.user_id,
  daily_session_id = snapshot.daily_session_id, source_revision = snapshot.source_revision,
  expected_data_epoch = owner.data_epoch
FROM evidence_source_snapshots snapshot, app_users owner
WHERE snapshot.evidence_source_snapshot_id = attempt.evidence_source_snapshot_id
  AND owner.user_id = snapshot.user_id;

CREATE UNIQUE INDEX evidence_model_run_attempts_dispatch_idx
  ON evidence_model_run_attempts(user_id, daily_session_id, source_revision, extraction_policy_version, expected_data_epoch)
  WHERE status = 'started' AND user_id IS NOT NULL;

ALTER TABLE evidence_model_run_attempts ADD COLUMN frozen_evidence_item_ids UUID[];
