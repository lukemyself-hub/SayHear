-- 1A.2 / #22: immutable, source-grounded Context projection.
CREATE TABLE rolling_summary_policies (
  policy_version TEXT PRIMARY KEY,
  minimum_uncovered_event_count INTEGER NOT NULL CHECK (minimum_uncovered_event_count > 0),
  minimum_uncovered_token_count INTEGER NOT NULL CHECK (minimum_uncovered_token_count > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO rolling_summary_policies VALUES ('rolling-summary:v1', 12, 3000, CURRENT_TIMESTAMP);
CREATE FUNCTION reject_rolling_summary_policy_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rolling Summary policies are immutable; create a new version';
END;
$$;
CREATE TRIGGER rolling_summary_policy_immutable
BEFORE UPDATE OR DELETE ON rolling_summary_policies
FOR EACH ROW EXECUTE FUNCTION reject_rolling_summary_policy_mutation();

ALTER TABLE workflow_commands DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (command_type IN ('journal_eligibility', 'rolling_summary'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN ('journal_eligibility_requested', 'rolling_summary_requested'));

CREATE TABLE rolling_summary_commands (
  rolling_summary_command_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  dialogue_revision BIGINT NOT NULL CHECK (dialogue_revision >= 0),
  coverage_start_sequence_no BIGINT NOT NULL CHECK (coverage_start_sequence_no > 0),
  covered_through_sequence_no BIGINT NOT NULL CHECK (covered_through_sequence_no >= coverage_start_sequence_no),
  policy_version TEXT NOT NULL REFERENCES rolling_summary_policies(policy_version),
  minimum_uncovered_event_count INTEGER NOT NULL CHECK (minimum_uncovered_event_count > 0),
  minimum_uncovered_token_count INTEGER NOT NULL CHECK (minimum_uncovered_token_count > 0),
  prompt_version TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','running','failed','published','stale')),
  claimed_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code IN ('summary_generation_failed', 'summary_result_unknown')),
  created_at TIMESTAMPTZ NOT NULL,
  -- A correction changes the Session source revision while preserving the
  -- sequence range. Keep that corrected snapshot independently rebuildable.
  UNIQUE (daily_session_id, source_revision, coverage_start_sequence_no, covered_through_sequence_no, policy_version)
);
CREATE TABLE rolling_summary_command_source_refs (
  rolling_summary_command_id UUID NOT NULL REFERENCES rolling_summary_commands(rolling_summary_command_id) ON DELETE CASCADE,
  conversation_event_revision_id UUID NOT NULL REFERENCES conversation_event_revisions(conversation_event_revision_id),
  sequence_no BIGINT NOT NULL CHECK (sequence_no > 0),
  PRIMARY KEY (rolling_summary_command_id, conversation_event_revision_id),
  UNIQUE (rolling_summary_command_id, sequence_no)
);
CREATE FUNCTION enforce_rolling_summary_source_ref_scope()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rolling_summary_commands command
    INNER JOIN conversation_event_revisions revision
      ON revision.conversation_event_revision_id = NEW.conversation_event_revision_id
    INNER JOIN conversation_events event
      ON event.conversation_event_id = revision.conversation_event_id
    WHERE command.rolling_summary_command_id = NEW.rolling_summary_command_id
      AND event.user_id = command.user_id
      AND event.daily_session_id = command.daily_session_id
      AND event.sequence_no = NEW.sequence_no
  ) THEN
    RAISE EXCEPTION 'Rolling Summary source must belong to the frozen Session and sequence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rolling_summary_source_ref_scope
BEFORE INSERT OR UPDATE ON rolling_summary_command_source_refs
FOR EACH ROW EXECUTE FUNCTION enforce_rolling_summary_source_ref_scope();
CREATE TABLE rolling_summary_versions (
  rolling_summary_version_id UUID PRIMARY KEY,
  rolling_summary_command_id UUID NOT NULL UNIQUE REFERENCES rolling_summary_commands(rolling_summary_command_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  covered_through_sequence_no BIGINT NOT NULL CHECK (covered_through_sequence_no > 0),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, version_no),
  UNIQUE (rolling_summary_version_id, user_id, daily_session_id, covered_through_sequence_no)
);
CREATE TABLE current_rolling_summaries (
  daily_session_id UUID PRIMARY KEY REFERENCES daily_sessions(daily_session_id),
  rolling_summary_version_id UUID NOT NULL,
  user_id UUID NOT NULL,
  covered_through_sequence_no BIGINT NOT NULL CHECK (covered_through_sequence_no > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (rolling_summary_version_id, user_id, daily_session_id, covered_through_sequence_no)
    REFERENCES rolling_summary_versions(rolling_summary_version_id, user_id, daily_session_id, covered_through_sequence_no)
);

ALTER TABLE compiled_contexts ADD COLUMN rolling_summary JSONB;
ALTER TABLE compiled_contexts DROP CONSTRAINT compiled_contexts_degraded_reason_check;
ALTER TABLE compiled_contexts ADD CONSTRAINT compiled_contexts_degraded_reason_check
  CHECK (degraded_reason IN ('raw_event_budget_exceeded', 'rolling_summary_failed'));
ALTER TABLE compiled_contexts ADD CONSTRAINT compiled_contexts_rolling_summary_object_check
  CHECK (rolling_summary IS NULL OR jsonb_typeof(rolling_summary) = 'object');
