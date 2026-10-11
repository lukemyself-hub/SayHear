-- #314: frozen result of one controlled read-only history review.
--
-- One row per Decision Command that ended in a history query proposal. It
-- freezes the deterministic plan, the read status, the content-free coverage
-- manifest and the ordered revision references the History Answer command may
-- be compiled from. It never stores message bodies: the compiler re-reads and
-- re-qualifies every referenced revision. The Decision and answer command ids
-- are plain UUIDs on purpose: the generation command ledger is a protected G1
-- surface and ownership is enforced by the owner column plus the repository.
CREATE TABLE history_recall_results (
  history_recall_result_id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  interaction_turn_id UUID NOT NULL,
  decision_command_id UUID NOT NULL,
  answer_command_id UUID NOT NULL,
  policy_version TEXT NOT NULL CHECK (policy_version <> ''),
  status TEXT NOT NULL CHECK (status IN ('completed', 'partial', 'failed')),
  failure_code TEXT CHECK (failure_code IS NULL OR failure_code <> ''),
  plan JSONB NOT NULL,
  coverage JSONB NOT NULL,
  item_refs JSONB NOT NULL,
  expected_data_epoch BIGINT NOT NULL CHECK (expected_data_epoch > 0),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK ((status = 'failed') = (failure_code IS NOT NULL)),
  CHECK (jsonb_typeof(item_refs) = 'array'),
  UNIQUE (decision_command_id),
  UNIQUE (answer_command_id),
  FOREIGN KEY (interaction_turn_id, user_id)
    REFERENCES interaction_turns(interaction_turn_id, user_id)
);

CREATE INDEX history_recall_results_owner_turn_idx
  ON history_recall_results(user_id, interaction_turn_id);

-- Frozen context references: a history ref names the Daily Session of the
-- referenced revision's event and carries its expression instant, exactly like
-- the recent-context refs, under its own section and selection reason.
CREATE OR REPLACE FUNCTION enforce_compiled_context_recent_ref_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.section IN ('recent_conversation_context', 'history_recall_context') THEN
    IF NOT EXISTS (
      SELECT 1
      FROM conversation_event_revisions revision
      INNER JOIN conversation_events event
        ON event.conversation_event_id = revision.conversation_event_id
       AND event.user_id = revision.user_id
      WHERE revision.conversation_event_revision_id =
          NEW.conversation_event_revision_id
        AND revision.user_id = NEW.user_id
        AND event.daily_session_id = NEW.daily_session_id
    ) THEN
      RAISE EXCEPTION
        'context ref session does not own its referenced revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_section_check;
ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_section_check
  CHECK (
    section IN (
      'committed_raw_events',
      'current_user_input',
      'recent_conversation_context',
      'history_recall_context'
    )
  );

ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_selection_order_check;
ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_selection_order_check
  CHECK (
    (section = 'committed_raw_events' AND selection_order IS NOT NULL AND selection_order >= 0)
    OR (section = 'current_user_input' AND selection_order IS NULL)
    OR (section = 'recent_conversation_context' AND selection_order IS NOT NULL AND selection_order >= 0)
    OR (section = 'history_recall_context' AND selection_order IS NOT NULL AND selection_order >= 0)
  );

ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_recent_metadata_check;
ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_recent_metadata_check
  CHECK (
    (
      section = 'recent_conversation_context'
      AND daily_session_id IS NOT NULL
      AND expressed_at IS NOT NULL
      AND selection_reason IN ('today', 'day_representation', 'budget_fill')
    )
    OR (
      section = 'history_recall_context'
      AND daily_session_id IS NOT NULL
      AND expressed_at IS NOT NULL
      AND selection_reason = 'history_date_range'
    )
    OR (
      section NOT IN ('recent_conversation_context', 'history_recall_context')
      AND daily_session_id IS NULL
      AND expressed_at IS NULL
      AND occurred_at IS NULL
      AND selection_reason IS NULL
    )
  );
