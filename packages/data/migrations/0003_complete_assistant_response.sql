CREATE TABLE generation_commands (
  generation_command_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  interaction_turn_id UUID NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type = 'conversation.text'),
  intent_key TEXT NOT NULL,
  subject_type TEXT NOT NULL CHECK (subject_type = 'conversation_event'),
  subject_id UUID NOT NULL,
  input_revision_kind TEXT NOT NULL
    CHECK (input_revision_kind = 'conversation_event_revision'),
  input_revision_id UUID NOT NULL,
  prompt_version TEXT NOT NULL,
  product_policy_version TEXT NOT NULL,
  safety_policy_version TEXT NOT NULL,
  relationship_policy_version TEXT NOT NULL,
  locale_policy_version TEXT NOT NULL,
  locale TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_snapshot TEXT NOT NULL,
  model_config_version TEXT NOT NULL,
  freshness_policy TEXT NOT NULL CHECK (freshness_policy = 'source_valid:v1'),
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  status TEXT NOT NULL
    CHECK (status IN ('prepared', 'running', 'succeeded', 'failed', 'interrupted')),
  compiled_context_id UUID,
  authoritative_result_id UUID,
  created_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  UNIQUE (user_id, intent_key),
  UNIQUE (interaction_turn_id),
  UNIQUE (generation_command_id, user_id),
  FOREIGN KEY (interaction_turn_id, user_id)
    REFERENCES interaction_turns(interaction_turn_id, user_id),
  FOREIGN KEY (subject_id, user_id)
    REFERENCES conversation_events(conversation_event_id, user_id),
  FOREIGN KEY (input_revision_id, subject_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id,
      conversation_event_id,
      user_id
    )
);

CREATE TABLE model_run_attempts (
  model_run_attempt_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  generation_command_id UUID NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  operation_type TEXT NOT NULL CHECK (operation_type = 'conversation.text'),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  model_snapshot TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL
    CHECK (
      status IN (
        'prepared',
        'running',
        'succeeded',
        'failed',
        'interrupted',
        'result_unknown'
      )
    ),
  provider_request_id TEXT,
  started_at TIMESTAMPTZ,
  first_token_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  input_tokens BIGINT CHECK (input_tokens >= 0),
  output_tokens BIGINT CHECK (output_tokens >= 0),
  cost_micros BIGINT CHECK (cost_micros >= 0),
  finish_reason TEXT,
  error_category TEXT
    CHECK (
      error_category IN (
        'aborted',
        'authentication',
        'invalid_response',
        'policy_blocked',
        'rate_limited',
        'timeout',
        'unavailable',
        'unknown'
      )
    ),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (generation_command_id, attempt_no),
  UNIQUE (model_run_attempt_id, user_id),
  FOREIGN KEY (generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id)
);

CREATE TABLE compiled_contexts (
  compiled_context_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  generation_command_id UUID NOT NULL,
  compiler_version TEXT NOT NULL,
  dialogue_revision BIGINT NOT NULL CHECK (dialogue_revision >= 0),
  source_revision BIGINT NOT NULL CHECK (source_revision >= 0),
  locale TEXT NOT NULL,
  section_budgets JSONB NOT NULL,
  total_tokens BIGINT NOT NULL CHECK (total_tokens >= 0),
  degraded_reason TEXT CHECK (degraded_reason = 'raw_event_budget_exceeded'),
  content_hmac TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (generation_command_id),
  UNIQUE (compiled_context_id, user_id),
  FOREIGN KEY (generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id)
);

CREATE TABLE compiled_context_revision_refs (
  compiled_context_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  conversation_event_revision_id UUID NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant')),
  estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens > 0),
  PRIMARY KEY (compiled_context_id, ordinal),
  UNIQUE (compiled_context_id, conversation_event_revision_id),
  FOREIGN KEY (compiled_context_id, user_id)
    REFERENCES compiled_contexts(compiled_context_id, user_id),
  FOREIGN KEY (conversation_event_revision_id, user_id)
    REFERENCES conversation_event_revisions(
      conversation_event_revision_id,
      user_id
    )
);

CREATE TABLE provider_egress_dispositions (
  provider_egress_disposition_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  model_run_attempt_id UUID NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'conversation.text'),
  provider_policy_version TEXT NOT NULL,
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  status TEXT NOT NULL
    CHECK (status IN ('blocked', 'dispatched', 'completed', 'failed')),
  error_category TEXT
    CHECK (
      error_category IN (
        'aborted',
        'authentication',
        'invalid_response',
        'policy_blocked',
        'rate_limited',
        'timeout',
        'unavailable',
        'unknown'
      )
    ),
  checked_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (model_run_attempt_id),
  FOREIGN KEY (model_run_attempt_id, user_id)
    REFERENCES model_run_attempts(model_run_attempt_id, user_id)
);

ALTER TABLE conversation_events
  ADD COLUMN generation_command_id UUID;

ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_generation_command_fk
  FOREIGN KEY (generation_command_id, user_id)
  REFERENCES generation_commands(generation_command_id, user_id);

CREATE UNIQUE INDEX conversation_events_assistant_generation_command_idx
  ON conversation_events(generation_command_id)
  WHERE actor = 'assistant';

ALTER TABLE conversation_event_revisions
  DROP CONSTRAINT conversation_event_revisions_created_by_check;

ALTER TABLE conversation_event_revisions
  ADD CONSTRAINT conversation_event_revisions_created_by_check
  CHECK (created_by IN ('client', 'user_correction', 'provider'));

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_compiled_context_fk
  FOREIGN KEY (compiled_context_id, user_id)
  REFERENCES compiled_contexts(compiled_context_id, user_id);

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_authoritative_result_fk
  FOREIGN KEY (authoritative_result_id, user_id)
  REFERENCES conversation_event_revisions(
    conversation_event_revision_id,
    user_id
  );
