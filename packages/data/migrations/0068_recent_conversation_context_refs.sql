-- #293: frozen recent-conversation-context revision refs.
--
-- The recent section freezes revision identities plus cross-session ordering
-- metadata, never message bodies. Legacy sections keep NULL metadata so
-- existing manifests replay unchanged.

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN daily_session_id UUID;

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN expressed_at TIMESTAMPTZ;

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN occurred_at TIMESTAMPTZ;

ALTER TABLE compiled_context_revision_refs
  ADD COLUMN selection_reason TEXT;

-- A recent ref names the Daily Session of the referenced revision's event, so
-- the session must exist and belong to the ref owner (ADR-0085 lineage).
-- MATCH SIMPLE skips this for legacy rows whose daily_session_id is NULL.
ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_daily_session_fk
  FOREIGN KEY (daily_session_id, user_id)
  REFERENCES daily_sessions(daily_session_id, user_id);

-- Owner + session existence is not enough: the referenced revision must
-- actually belong to that Daily Session. The revision -> event -> session
-- join cannot be expressed as a plain composite foreign key because the
-- revision table does not carry the session, so enforce it with a trigger.
CREATE FUNCTION enforce_compiled_context_recent_ref_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.section = 'recent_conversation_context' THEN
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
        'recent-context ref session does not own its referenced revision'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER compiled_context_revision_refs_recent_session
BEFORE INSERT OR UPDATE ON compiled_context_revision_refs
FOR EACH ROW
EXECUTE FUNCTION enforce_compiled_context_recent_ref_session();

ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_section_check;

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_section_check
  CHECK (
    section IN (
      'committed_raw_events',
      'current_user_input',
      'recent_conversation_context'
    )
  );

ALTER TABLE compiled_context_revision_refs
  DROP CONSTRAINT compiled_context_revision_refs_selection_order_check;

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_selection_order_check
  CHECK (
    (
      section = 'committed_raw_events'
      AND selection_order IS NOT NULL
      AND selection_order >= 0
    )
    OR (
      section = 'current_user_input'
      AND selection_order IS NULL
    )
    OR (
      section = 'recent_conversation_context'
      AND selection_order IS NOT NULL
      AND selection_order >= 0
    )
  );

ALTER TABLE compiled_context_revision_refs
  ADD CONSTRAINT compiled_context_revision_refs_recent_metadata_check
  CHECK (
    (
      section = 'recent_conversation_context'
      AND daily_session_id IS NOT NULL
      AND expressed_at IS NOT NULL
      AND selection_reason IS NOT NULL
      AND selection_reason IN (
        'today',
        'day_representation',
        'budget_fill'
      )
    )
    OR (
      section <> 'recent_conversation_context'
      AND daily_session_id IS NULL
      AND expressed_at IS NULL
      AND occurred_at IS NULL
      AND selection_reason IS NULL
    )
  );
