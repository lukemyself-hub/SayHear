-- #314 / ADR-0094: the History Answer GenerationCommand is its own stage.
-- This file deliberately contains only the stage CHECK widening that the
-- G1 schema-extension guard admits (exactly the history_answer value on top
-- of the frozen stage set); every other change of this ticket is in 0072.
ALTER TABLE generation_commands DROP CONSTRAINT IF EXISTS generation_commands_generation_stage_check;
ALTER TABLE generation_commands ADD CONSTRAINT generation_commands_generation_stage_check CHECK (generation_stage IN ('decision', 'action_finalization', 'proactive_followup', 'history_answer'));
