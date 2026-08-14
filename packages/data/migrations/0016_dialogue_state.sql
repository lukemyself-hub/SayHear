-- 1A.2 / #23: short-lived, source-grounded DialogueState projection.
CREATE TABLE dialogue_state_policies (
  policy_version TEXT PRIMARY KEY,
  prompt_version TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO dialogue_state_policies (
  policy_version, prompt_version, model_config_version
)
VALUES (
  'dialogue-state:v1', 'dialogue-state-prompt:v1', 'dialogue-state-model:v1'
);

CREATE FUNCTION reject_dialogue_state_policy_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'DialogueState policies are immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER dialogue_state_policies_immutable
BEFORE UPDATE OR DELETE ON dialogue_state_policies
FOR EACH ROW EXECUTE FUNCTION reject_dialogue_state_policy_mutation();

ALTER TABLE workflow_commands DROP CONSTRAINT workflow_commands_command_type_check;
ALTER TABLE workflow_commands ADD CONSTRAINT workflow_commands_command_type_check
  CHECK (command_type IN ('journal_eligibility', 'rolling_summary', 'dialogue_state'));

ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_event_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_event_type_check
  CHECK (event_type IN (
    'journal_eligibility_requested', 'rolling_summary_requested', 'dialogue_state_requested'
  ));

CREATE TABLE dialogue_state_commands (
  dialogue_state_command_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  dialogue_revision BIGINT NOT NULL CHECK (dialogue_revision >= 0),
  coverage_through_sequence_no BIGINT NOT NULL CHECK (coverage_through_sequence_no > 0),
  policy_version TEXT NOT NULL REFERENCES dialogue_state_policies(policy_version),
  prompt_version TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created', 'running', 'failed', 'published', 'stale')),
  claimed_at TIMESTAMPTZ,
  last_error_code TEXT CHECK (
    last_error_code IS NULL OR last_error_code IN (
      'dialogue_state_generation_failed', 'dialogue_state_result_unknown'
    )
  ),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, source_revision, dialogue_revision, policy_version)
);

CREATE TABLE dialogue_state_command_source_refs (
  dialogue_state_command_id UUID NOT NULL REFERENCES dialogue_state_commands(dialogue_state_command_id) ON DELETE CASCADE,
  conversation_event_revision_id UUID NOT NULL REFERENCES conversation_event_revisions(conversation_event_revision_id),
  sequence_no BIGINT NOT NULL CHECK (sequence_no > 0),
  PRIMARY KEY (dialogue_state_command_id, conversation_event_revision_id),
  UNIQUE (dialogue_state_command_id, sequence_no)
);

CREATE FUNCTION enforce_dialogue_state_source_ref_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM dialogue_state_commands command
    INNER JOIN conversation_event_revisions revision
      ON revision.conversation_event_revision_id = NEW.conversation_event_revision_id
    INNER JOIN conversation_events event
      ON event.conversation_event_id = revision.conversation_event_id
    WHERE command.dialogue_state_command_id = NEW.dialogue_state_command_id
      AND event.user_id = command.user_id
      AND event.daily_session_id = command.daily_session_id
      AND event.sequence_no = NEW.sequence_no
  ) THEN
    RAISE EXCEPTION 'DialogueState source must belong to the frozen Session and sequence';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER dialogue_state_source_ref_scope
BEFORE INSERT OR UPDATE ON dialogue_state_command_source_refs
FOR EACH ROW EXECUTE FUNCTION enforce_dialogue_state_source_ref_scope();

CREATE TABLE dialogue_state_versions (
  dialogue_state_version_id UUID PRIMARY KEY,
  dialogue_state_command_id UUID NOT NULL UNIQUE REFERENCES dialogue_state_commands(dialogue_state_command_id),
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL REFERENCES daily_sessions(daily_session_id),
  version_no BIGINT NOT NULL CHECK (version_no > 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  dialogue_revision BIGINT NOT NULL CHECK (dialogue_revision >= 0),
  covered_through_sequence_no BIGINT NOT NULL CHECK (covered_through_sequence_no > 0),
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (daily_session_id, version_no),
  UNIQUE (
    dialogue_state_version_id, user_id, daily_session_id,
    source_revision, dialogue_revision, covered_through_sequence_no
  )
);

CREATE TABLE current_dialogue_states (
  daily_session_id UUID PRIMARY KEY REFERENCES daily_sessions(daily_session_id),
  dialogue_state_version_id UUID NOT NULL,
  user_id UUID NOT NULL,
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  dialogue_revision BIGINT NOT NULL CHECK (dialogue_revision >= 0),
  covered_through_sequence_no BIGINT NOT NULL CHECK (covered_through_sequence_no > 0),
  updated_at TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (
    dialogue_state_version_id, user_id, daily_session_id,
    source_revision, dialogue_revision, covered_through_sequence_no
  ) REFERENCES dialogue_state_versions(
    dialogue_state_version_id, user_id, daily_session_id,
    source_revision, dialogue_revision, covered_through_sequence_no
  )
);

ALTER TABLE compiled_contexts DROP CONSTRAINT compiled_contexts_degraded_reason_check;
ALTER TABLE compiled_contexts ADD CONSTRAINT compiled_contexts_degraded_reason_check
  CHECK (degraded_reason IN (
    'raw_event_budget_exceeded', 'rolling_summary_failed',
    'dialogue_state_failed', 'dialogue_state_lagging'
  ));
