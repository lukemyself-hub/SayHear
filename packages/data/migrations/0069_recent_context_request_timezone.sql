-- #294: freeze the admitted request IANA timezone on the GenerationCommand.
--
-- Recent-context windows must anchor to the timezone of the actual admitted
-- request, not the stale session-start timezone: travel keeps one Daily
-- Session, so `daily_sessions.timezone_at_start` would read the wrong local day
-- after the owner changes zones (ADR-0149). Legacy / model-role commands keep
-- NULL and fall back to the session-start zone; the original zone of a legacy
-- request is not recoverable and is never fabricated.
ALTER TABLE generation_commands
  ADD COLUMN request_timezone TEXT;

-- The bounded recent-context source reads one owner's expression-time range
-- and orders by expression instant before rows/bytes are capped. A dedicated
-- owner + created_at index keeps that scan bounded instead of a whole-table
-- scan as owner history grows.
CREATE INDEX conversation_events_recent_context_idx
  ON conversation_events(user_id, created_at);
