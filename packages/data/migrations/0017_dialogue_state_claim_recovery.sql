-- Reclaimable DialogueState executions use an attempt-scoped claim fence.
-- A timed-out attempt may be retried, but its late result must not publish.
ALTER TABLE dialogue_state_commands
  ADD COLUMN claim_id UUID;
