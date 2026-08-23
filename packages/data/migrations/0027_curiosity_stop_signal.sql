-- 1A.2P / #74: the session-scoped Curiosity Stop Signal projection.
--
-- The projection is committed by deterministic code inside the same
-- transaction as the Complete Assistant Response (the model only proposes);
-- there is no async command/claim machinery like DialogueState. Rows keep a
-- minimal envelope (ADR-0101 discipline): bounded direction labels, signal
-- enums, and Event revision references only — no user or assistant content.

CREATE TABLE curiosity_stop_signal_policies (
  policy_version TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO curiosity_stop_signal_policies (policy_version)
VALUES ('curiosity-stop-signal:v1');

CREATE FUNCTION reject_curiosity_stop_signal_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CuriosityStopSignal policies are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER curiosity_stop_signal_policies_immutable
BEFORE UPDATE OR DELETE ON curiosity_stop_signal_policies
FOR EACH ROW EXECUTE FUNCTION reject_curiosity_stop_signal_policy_mutation();

-- Immutable version rows. `source_revision` is the Daily Session
-- source_revision AFTER the committing response's bump, so every projection
-- version is ordered with the dialogue history that produced it. The
-- proactive-follow-up usage slot is part of the content contract and must
-- stay unwritten until 1A.3b; the CHECK below enforces that at the storage
-- boundary.
CREATE TABLE curiosity_stop_signals (
  curiosity_stop_signal_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  policy_version TEXT NOT NULL REFERENCES curiosity_stop_signal_policies(policy_version),
  content JSONB NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND content ? 'suppressedDirections'
    AND jsonb_typeof(content->'suppressedDirections') = 'array'
    AND content ? 'blanketStop'
    -- A jsonb `null` is a value, not SQL NULL, so the unwritten-slot check
    -- must go through jsonb_typeof (absent key or explicit json null).
    AND (
      content->'proactiveFollowupUsage' IS NULL
      OR jsonb_typeof(content->'proactiveFollowupUsage') = 'null'
    )
  ),
  committed_generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, version_no),
  UNIQUE (
    curiosity_stop_signal_id, user_id, daily_session_id,
    source_revision, version_no
  )
);

CREATE TABLE current_curiosity_stop_signals (
  daily_session_id UUID PRIMARY KEY REFERENCES daily_sessions(daily_session_id),
  curiosity_stop_signal_id UUID NOT NULL,
  user_id UUID NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (curiosity_stop_signal_id, user_id, daily_session_id, source_revision, version_no)
    REFERENCES curiosity_stop_signals(
      curiosity_stop_signal_id, user_id, daily_session_id, source_revision, version_no
    )
);
