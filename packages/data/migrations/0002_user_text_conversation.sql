CREATE TABLE daily_sessions (
  daily_session_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  logical_date DATE NOT NULL,
  timezone_at_start TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  activity_state TEXT NOT NULL DEFAULT 'active'
    CHECK (activity_state IN ('active', 'quiescent', 'finalized')),
  current_continuous_exchange_no INTEGER NOT NULL DEFAULT 1
    CHECK (current_continuous_exchange_no > 0),
  dialogue_revision BIGINT NOT NULL DEFAULT 0 CHECK (dialogue_revision >= 0),
  source_revision BIGINT NOT NULL DEFAULT 0 CHECK (source_revision >= 0),
  next_turn_sequence_no BIGINT NOT NULL DEFAULT 1
    CHECK (next_turn_sequence_no > 0),
  next_event_sequence_no BIGINT NOT NULL DEFAULT 1
    CHECK (next_event_sequence_no > 0),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, logical_date),
  UNIQUE (daily_session_id, user_id)
);

CREATE UNIQUE INDEX daily_sessions_one_active_per_user_idx
  ON daily_sessions(user_id)
  WHERE activity_state = 'active';

CREATE TABLE interaction_turns (
  interaction_turn_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  client_turn_id TEXT NOT NULL,
  turn_sequence_no BIGINT NOT NULL CHECK (turn_sequence_no > 0),
  continuous_exchange_no INTEGER NOT NULL CHECK (continuous_exchange_no > 0),
  status TEXT NOT NULL
    CHECK (status IN ('open', 'responding', 'settled', 'interrupted', 'failed')),
  retry_of_interaction_turn_id UUID,
  started_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, client_turn_id),
  UNIQUE (daily_session_id, turn_sequence_no),
  UNIQUE (interaction_turn_id, user_id),
  UNIQUE (interaction_turn_id, daily_session_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  FOREIGN KEY (retry_of_interaction_turn_id, user_id)
    REFERENCES interaction_turns(interaction_turn_id, user_id)
);

CREATE TABLE conversation_events (
  conversation_event_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  daily_session_id UUID NOT NULL,
  interaction_turn_id UUID NOT NULL,
  sequence_no BIGINT NOT NULL CHECK (sequence_no > 0),
  client_event_id TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('user', 'assistant', 'system')),
  channel TEXT NOT NULL CHECK (channel IN ('text', 'realtime')),
  event_type TEXT NOT NULL,
  current_revision_id UUID,
  lifecycle_status TEXT NOT NULL
    CHECK (lifecycle_status IN ('active', 'superseded', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  UNIQUE (user_id, client_event_id),
  UNIQUE (daily_session_id, sequence_no),
  UNIQUE (conversation_event_id, user_id),
  FOREIGN KEY (daily_session_id, user_id)
    REFERENCES daily_sessions(daily_session_id, user_id),
  CONSTRAINT conversation_events_interaction_turn_session_fk
    FOREIGN KEY (interaction_turn_id, daily_session_id, user_id)
    REFERENCES interaction_turns(
      interaction_turn_id,
      daily_session_id,
      user_id
    )
);

CREATE UNIQUE INDEX conversation_events_primary_user_turn_idx
  ON conversation_events(interaction_turn_id)
  WHERE actor = 'user';

CREATE TABLE conversation_event_revisions (
  conversation_event_revision_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  conversation_event_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  locale TEXT NOT NULL,
  canonical_text TEXT NOT NULL,
  transcript_status TEXT NOT NULL
    CHECK (transcript_status IN ('final', 'corrected')),
  created_by TEXT NOT NULL CHECK (created_by IN ('client', 'user_correction')),
  created_at TIMESTAMPTZ NOT NULL,
  content_purged_at TIMESTAMPTZ,
  UNIQUE (conversation_event_id, revision),
  UNIQUE (conversation_event_revision_id, user_id),
  UNIQUE (
    conversation_event_revision_id,
    conversation_event_id,
    user_id
  ),
  FOREIGN KEY (conversation_event_id, user_id)
    REFERENCES conversation_events(conversation_event_id, user_id)
);

ALTER TABLE conversation_events
  ADD CONSTRAINT conversation_events_current_revision_fk
  FOREIGN KEY (
    current_revision_id,
    conversation_event_id,
    user_id
  )
  REFERENCES conversation_event_revisions(
    conversation_event_revision_id,
    conversation_event_id,
    user_id
  );

CREATE UNIQUE INDEX conversation_events_current_revision_idx
  ON conversation_events(current_revision_id)
  WHERE current_revision_id IS NOT NULL;

CREATE FUNCTION enforce_conversation_event_revision_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF
    TG_OP = 'UPDATE'
    AND OLD.content_purged_at IS NULL
    AND NEW.content_purged_at IS NOT NULL
    AND NEW.canonical_text = ''
    AND NEW.conversation_event_revision_id = OLD.conversation_event_revision_id
    AND NEW.user_id = OLD.user_id
    AND NEW.conversation_event_id = OLD.conversation_event_id
    AND NEW.revision = OLD.revision
    AND NEW.locale = OLD.locale
    AND NEW.transcript_status = OLD.transcript_status
    AND NEW.created_by = OLD.created_by
    AND NEW.created_at = OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ConversationEventRevision is immutable'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER conversation_event_revisions_immutable
BEFORE UPDATE OR DELETE ON conversation_event_revisions
FOR EACH ROW
EXECUTE FUNCTION enforce_conversation_event_revision_immutability();
