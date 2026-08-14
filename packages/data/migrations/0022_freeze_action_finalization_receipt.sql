-- Issue #26 review hardening: an Action Finalization Command must carry the
-- exact committed Receipt snapshot that its tools-disabled response is allowed
-- to describe.  Later receipts remain authoritative for recovery, but cannot
-- silently change the source frozen for this GenerationCommand.

ALTER TABLE generation_commands
  ADD COLUMN action_receipt_sequence INTEGER,
  ADD COLUMN action_execution_status TEXT;

ALTER TABLE generation_commands
  ADD CONSTRAINT generation_commands_action_receipt_snapshot_check
  CHECK (
    generation_stage <> 'action_finalization'
    OR (
      action_execution_id IS NOT NULL
      AND action_receipt_sequence IS NOT NULL
      AND action_receipt_sequence > 0
      AND action_execution_status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')
    )
  );
