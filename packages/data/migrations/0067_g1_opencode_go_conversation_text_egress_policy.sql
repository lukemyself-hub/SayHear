-- ADR-0147 follow-up: register the OpenCode Go conversation.text egress policy.
--
-- 0065 moved the Conversation Champion to the OpenCode Go adapter but only
-- registered the four G1 role egress policies. The Champion's own
-- conversation.text row was missed: generation_commands.provider_policy_version
-- is a foreign key into provider_egress_policy_versions, and claimDispatch joins
-- the policy row on (policy_version, provider, role). A hosted conversation on
-- an OpenCode Go deployment therefore failed on
-- generation_commands_provider_policy_fk - the same defect class 0008 fixed for
-- DeepSeek. The row mirrors the DeepSeek/OpenAI Champion rows:
-- conversation-text-champion:v1, no consent policy, active.
INSERT INTO provider_egress_policy_versions (
  policy_version,
  provider,
  role,
  model_config_version,
  consent_policy_version,
  status
)
VALUES (
  'opencode-go-conversation-text:v1',
  'opencode-go',
  'conversation.text',
  'conversation-text-champion:v1',
  NULL,
  'active'
)
ON CONFLICT (policy_version) DO NOTHING;
