-- A user correction is a new immutable Event Revision. Once it becomes the
-- current revision, the Daily Session head must advance so stale Journal work
-- cannot publish and the normal eligibility scanner can enqueue a successor.
CREATE FUNCTION advance_daily_session_source_for_user_correction()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_revision_id IS NOT NULL
    AND NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
    AND NEW.actor = 'user'
  THEN
    UPDATE daily_sessions
    SET source_revision = source_revision + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE daily_session_id = NEW.daily_session_id
      AND user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER conversation_event_user_correction_advances_journal_source
AFTER UPDATE OF current_revision_id ON conversation_events
FOR EACH ROW EXECUTE FUNCTION advance_daily_session_source_for_user_correction();
