-- Action Finalization is a second GenerationCommand for the same InteractionTurn;
-- retain one decision command per turn while allowing its distinct finalization.

ALTER TABLE generation_commands
  DROP CONSTRAINT IF EXISTS generation_commands_interaction_turn_id_key;

CREATE UNIQUE INDEX generation_commands_one_decision_per_turn_idx
  ON generation_commands(interaction_turn_id)
  WHERE generation_stage = 'decision';
