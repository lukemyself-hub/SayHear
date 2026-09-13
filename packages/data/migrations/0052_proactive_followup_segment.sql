-- 1A.3b C3 / issue #206.
--
-- A proactive segment is a separate, tools-disabled GenerationCommand. The
-- Assistant Event keeps the main command as its primary command for existing
-- readers; this owner-scoped lineage table records both commands without
-- copying either response's text. The response repository writes the event,
-- lineage, segment result, use, and reservation transition in one transaction.

ALTER TABLE generation_commands
  DROP CONSTRAINT IF EXISTS generation_commands_generation_stage_check;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_generation_stage_check
  CHECK (
    generation_stage IN ('decision', 'action_finalization', 'proactive_followup')
  );

CREATE TABLE conversation_event_generation_command_links (
  conversation_event_id UUID NOT NULL,
  generation_command_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES app_users(user_id),
  role TEXT NOT NULL CHECK (
    role IN ('main_response', 'proactive_segment', 'action_finalization')
  ),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (conversation_event_id, role),
  UNIQUE (generation_command_id, user_id),
  FOREIGN KEY (conversation_event_id, user_id)
    REFERENCES conversation_events(conversation_event_id, user_id),
  FOREIGN KEY (generation_command_id, user_id)
    REFERENCES generation_commands(generation_command_id, user_id)
);

CREATE INDEX conversation_event_generation_command_links_owner_event_idx
  ON conversation_event_generation_command_links(user_id, conversation_event_id);
