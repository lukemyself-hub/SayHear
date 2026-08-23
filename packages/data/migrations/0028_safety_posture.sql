-- 1A.2P / #76: the Daily-Session-scoped Safety Posture lifecycle (ADR-0112).
--
-- The posture is deterministic domain state on the Daily Session: versioned
-- deterministic detection of an explicit self-harm, harm-to-others, or
-- imminent-danger signal activates it inside the same transaction as the
-- Complete Assistant Response; it survives Continuous Exchange boundaries
-- within the day and does not survive the day, because the records are keyed
-- by the Daily Session that session resolution already scopes. Release is
-- automatic after K consecutive clean user turns; the runtime source of K is
-- the versioned application constant, and the immutable policy row below
-- records the same value at the storage boundary (the system tests pin the
-- two equal). A failed detector activates no new posture, holds any active
-- one, and raises an alert row. Records keep a minimal envelope (ADR-0101
-- discipline): signal enums, the clean-turn counter, and Event revision
-- references only — no user or assistant content.

CREATE TABLE safety_posture_policies (
  policy_version TEXT PRIMARY KEY,
  clean_turns_to_release INTEGER NOT NULL CHECK (clean_turns_to_release > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO safety_posture_policies (policy_version, clean_turns_to_release)
VALUES ('safety-posture:v1', 2);

CREATE FUNCTION reject_safety_posture_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'SafetyPosture policies are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER safety_posture_policies_immutable
BEFORE UPDATE OR DELETE ON safety_posture_policies
FOR EACH ROW EXECUTE FUNCTION reject_safety_posture_policy_mutation();

-- Immutable version rows. `source_revision` is the Daily Session
-- source_revision AFTER the committing response's bump, so every posture
-- version is ordered with the dialogue history that produced it. A session
-- with no row today simply has the default posture.
CREATE TABLE safety_postures (
  safety_posture_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  policy_version TEXT NOT NULL REFERENCES safety_posture_policies(policy_version),
  content JSONB NOT NULL CHECK (
    jsonb_typeof(content) = 'object'
    AND content ? 'state'
    AND jsonb_typeof(content->'state') = 'string'
    AND content->>'state' IN ('active', 'released')
    AND content ? 'kind'
    AND content ? 'cleanTurnCount'
    AND jsonb_typeof(content->'cleanTurnCount') = 'number'
    AND content ? 'evidence'
    AND jsonb_typeof(content->'evidence') = 'object'
    AND (content->'evidence') ? 'activatedUserEventRevisionId'
    AND (content->'evidence') ? 'lastTurnUserEventRevisionId'
  ),
  committed_generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, version_no),
  UNIQUE (safety_posture_id, user_id, daily_session_id, source_revision, version_no)
);

CREATE TABLE current_safety_postures (
  daily_session_id UUID PRIMARY KEY REFERENCES daily_sessions(daily_session_id),
  safety_posture_id UUID NOT NULL,
  user_id UUID NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (safety_posture_id, user_id, daily_session_id, source_revision, version_no)
    REFERENCES safety_postures(
      safety_posture_id, user_id, daily_session_id, source_revision, version_no
    )
);

-- Detector-failure alerts (ADR-0112: no new activation, active postures
-- held, alert raised). Minimal envelope: references only, never user text.
CREATE TABLE safety_posture_alerts (
  safety_posture_alert_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  generation_command_id UUID NOT NULL
    REFERENCES generation_commands(generation_command_id),
  policy_version TEXT NOT NULL REFERENCES safety_posture_policies(policy_version),
  reason TEXT NOT NULL CHECK (
    reason IN ('detector_failure', 'invalid_previous_projection', 'commit_failure')
  ),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX safety_posture_alerts_session_idx
  ON safety_posture_alerts (daily_session_id, occurred_at);
