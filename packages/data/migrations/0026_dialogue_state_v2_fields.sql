-- #75 / ADR-0111: DialogueState v2 replaces the pre-0111 projection fields with
-- the six semantic fields. The v1 policy row, historical commands, versions, and
-- pointers are preserved untouched; v2 commands carry the new policy/prompt
-- versions and the v2 content shape. The model configuration itself is unchanged.
INSERT INTO dialogue_state_policies (
  policy_version, prompt_version, model_config_version
)
VALUES (
  'dialogue-state:v2', 'dialogue-state-prompt:v2', 'dialogue-state-model:v1'
);
