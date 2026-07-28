ALTER TABLE daily_sessions
  ADD COLUMN quiescent_at TIMESTAMPTZ,
  ADD COLUMN quiescent_reason TEXT
    CHECK (
      quiescent_reason IN ('explicit_user_end', 'inactivity_timeout')
    );

CREATE TABLE continuous_exchange_inactivity_policies (
  policy_version TEXT PRIMARY KEY,
  timeout_ms BIGINT NOT NULL CHECK (timeout_ms > 0),
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO continuous_exchange_inactivity_policies (
  policy_version,
  timeout_ms,
  created_at
)
VALUES (
  'continuous-exchange-inactivity:v1',
  1800000,
  CURRENT_TIMESTAMP
);

CREATE FUNCTION reject_inactivity_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Inactivity policy versions are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER continuous_exchange_inactivity_policies_immutable
BEFORE UPDATE OR DELETE ON continuous_exchange_inactivity_policies
FOR EACH ROW
EXECUTE FUNCTION reject_inactivity_policy_mutation();

ALTER TABLE daily_sessions
  ADD COLUMN closure_policy_version TEXT NOT NULL
    DEFAULT 'continuous-exchange-inactivity:v1'
    REFERENCES continuous_exchange_inactivity_policies(policy_version);

CREATE TABLE continuous_exchange_inactivity_evaluations (
  inactivity_evaluation_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  continuous_exchange_no INTEGER NOT NULL
    CHECK (continuous_exchange_no > 0),
  policy_version TEXT NOT NULL
    REFERENCES continuous_exchange_inactivity_policies(policy_version),
  expected_dialogue_revision BIGINT NOT NULL
    CHECK (expected_dialogue_revision > 0),
  due_at TIMESTAMPTZ NOT NULL,
  evaluated_at TIMESTAMPTZ,
  outcome TEXT
    CHECK (
      outcome IN ('applied', 'stale_revision', 'not_active')
    ),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (
    daily_session_id,
    continuous_exchange_no,
    expected_dialogue_revision
  ),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  CHECK (
    (evaluated_at IS NULL AND outcome IS NULL)
    OR (evaluated_at IS NOT NULL AND outcome IS NOT NULL)
  )
);

CREATE FUNCTION enforce_inactivity_evaluation_snapshot_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'DELETE'
    OR NEW.inactivity_evaluation_id IS DISTINCT FROM OLD.inactivity_evaluation_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.daily_session_id IS DISTINCT FROM OLD.daily_session_id
    OR NEW.continuous_exchange_no IS DISTINCT FROM OLD.continuous_exchange_no
    OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
    OR NEW.expected_dialogue_revision IS DISTINCT
      FROM OLD.expected_dialogue_revision
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Inactivity evaluation snapshots are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER continuous_exchange_inactivity_evaluation_snapshot_immutable
BEFORE UPDATE OR DELETE ON continuous_exchange_inactivity_evaluations
FOR EACH ROW
EXECUTE FUNCTION enforce_inactivity_evaluation_snapshot_immutability();

CREATE INDEX continuous_exchange_inactivity_evaluations_due_idx
  ON continuous_exchange_inactivity_evaluations(due_at)
  WHERE outcome IS NULL;

CREATE FUNCTION enforce_daily_session_ownership_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    NEW.logical_date IS DISTINCT FROM OLD.logical_date
    OR NEW.timezone_at_start IS DISTINCT FROM OLD.timezone_at_start
  THEN
    RAISE EXCEPTION 'Daily Session ownership fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER daily_session_ownership_immutable
BEFORE UPDATE ON daily_sessions
FOR EACH ROW
EXECUTE FUNCTION enforce_daily_session_ownership_immutability();
