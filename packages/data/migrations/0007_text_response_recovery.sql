CREATE TABLE conversation_response_recovery_policies (
  policy_version TEXT PRIMARY KEY,
  recovery_window_ms BIGINT NOT NULL CHECK (recovery_window_ms > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0 AND max_attempts <= 10),
  base_retry_delay_ms BIGINT NOT NULL CHECK (base_retry_delay_ms >= 0),
  max_retry_delay_ms BIGINT NOT NULL CHECK (
    max_retry_delay_ms >= base_retry_delay_ms
  ),
  jitter_ratio DOUBLE PRECISION NOT NULL CHECK (
    jitter_ratio >= 0 AND jitter_ratio <= 1
  ),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO conversation_response_recovery_policies (
  policy_version,
  recovery_window_ms,
  max_attempts,
  base_retry_delay_ms,
  max_retry_delay_ms,
  jitter_ratio,
  created_at
)
VALUES (
  'conversation-response-recovery:v1',
  300000,
  3,
  250,
  5000,
  0.2,
  CURRENT_TIMESTAMP
);

CREATE FUNCTION reject_conversation_response_recovery_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Conversation response recovery policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER conversation_response_recovery_policies_immutable
BEFORE UPDATE OR DELETE ON conversation_response_recovery_policies
FOR EACH ROW
EXECUTE FUNCTION reject_conversation_response_recovery_policy_mutation();

ALTER TABLE generation_commands
  ADD COLUMN recovery_policy_version TEXT NOT NULL
    DEFAULT 'conversation-response-recovery:v1'
    REFERENCES conversation_response_recovery_policies(policy_version),
  ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      recovery_status IN (
        'pending',
        'recovering',
        'recovered',
        'interrupted',
        'terminal',
        'not_needed'
      )
    ),
  ADD COLUMN recovery_checked_at TIMESTAMPTZ,
  ADD COLUMN next_recovery_at TIMESTAMPTZ;

UPDATE generation_commands
SET recovery_status = CASE
  WHEN status = 'succeeded' THEN 'not_needed'
  WHEN status = 'interrupted' THEN 'interrupted'
  WHEN status = 'failed' THEN 'terminal'
  ELSE 'pending'
END;

ALTER TABLE model_run_attempts
  ADD COLUMN retry_of_model_run_attempt_id UUID
    REFERENCES model_run_attempts(model_run_attempt_id),
  ADD COLUMN recovery_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      recovery_status IN (
        'pending',
        'recovering',
        'retried',
        'recovered',
        'interrupted',
        'terminal',
        'not_needed'
      )
    ),
  ADD COLUMN retry_not_before TIMESTAMPTZ,
  ADD COLUMN recovery_claimed_at TIMESTAMPTZ,
  ADD COLUMN provider_completed_at TIMESTAMPTZ;

UPDATE model_run_attempts
SET recovery_status = CASE
  WHEN status = 'succeeded' THEN 'not_needed'
  WHEN status = 'interrupted' THEN 'interrupted'
  WHEN status = 'failed' THEN 'terminal'
  ELSE 'pending'
END;

ALTER TABLE generation_commands
  DROP CONSTRAINT generation_commands_status_check;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_status_check
  CHECK (
    status IN (
      'prepared',
      'compiling',
      'running',
      'retry_pending',
      'succeeded',
      'failed',
      'interrupted'
    )
  );

ALTER TABLE model_run_attempts
  DROP CONSTRAINT model_run_attempts_error_category_check;

ALTER TABLE model_run_attempts
  ADD CONSTRAINT model_run_attempts_error_category_check
  CHECK (
    error_category IN (
      'aborted',
      'authentication',
      'configuration',
      'invalid_response',
      'policy_blocked',
      'rate_limited',
      'timeout',
      'unavailable',
      'unknown'
    )
  );

ALTER TABLE provider_egress_dispositions
  DROP CONSTRAINT provider_egress_dispositions_error_category_check;

ALTER TABLE provider_egress_dispositions
  ADD CONSTRAINT provider_egress_dispositions_error_category_check
  CHECK (
    error_category IN (
      'aborted',
      'authentication',
      'configuration',
      'invalid_response',
      'policy_blocked',
      'rate_limited',
      'timeout',
      'unavailable',
      'unknown'
    )
  );

CREATE INDEX generation_commands_recovery_due_idx
  ON generation_commands(next_recovery_at)
  WHERE status = 'retry_pending';

CREATE INDEX model_run_attempts_recovery_scan_idx
  ON model_run_attempts(created_at, started_at)
  WHERE status IN ('prepared', 'running', 'result_unknown');
