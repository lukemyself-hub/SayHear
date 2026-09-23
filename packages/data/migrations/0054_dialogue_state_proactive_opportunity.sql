-- Issue #207 G2 v4: pin the event-bound opportunity classification used by
-- the proactive selector. Historical DialogueState policy rows stay intact.
INSERT INTO dialogue_state_policies (
  policy_version, prompt_version, model_config_version
)
VALUES (
  'dialogue-state:v3', 'dialogue-state-prompt:v3', 'dialogue-state-model:v1'
);
