-- Issue #26: persist a distinct, tools-disabled Action Finalization Command and
-- make progress / completion receipts idempotent without mutating history.

ALTER TABLE generation_commands
  ADD COLUMN generation_stage TEXT NOT NULL DEFAULT 'decision'
    CHECK (generation_stage IN ('decision', 'action_finalization')),
  ADD COLUMN action_execution_id UUID
    REFERENCES conversation_action_executions(action_execution_id);

ALTER TABLE workflow_commands
  ADD COLUMN action_execution_id UUID
    REFERENCES conversation_action_executions(action_execution_id);

ALTER TABLE conversation_action_receipts
  ADD COLUMN receipt_key TEXT;

UPDATE conversation_action_receipts
SET receipt_key = 'admission'
WHERE receipt_key IS NULL;

ALTER TABLE conversation_action_receipts
  ALTER COLUMN receipt_key SET NOT NULL;

CREATE UNIQUE INDEX conversation_action_receipts_key_idx
  ON conversation_action_receipts(action_execution_id, receipt_key);

CREATE UNIQUE INDEX generation_commands_action_finalization_idx
  ON generation_commands(action_execution_id)
  WHERE generation_stage = 'action_finalization';
