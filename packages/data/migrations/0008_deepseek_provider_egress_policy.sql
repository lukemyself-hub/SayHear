-- Register the DeepSeek provider egress policy version so that
-- claimDispatch's INNER JOIN on provider_egress_policy_versions
-- finds a row for provider = 'deepseek'. PR #15 added the adapter
-- and runtime configuration but missed this seed row, causing
-- every DeepSeek egress to be blocked as policy_blocked.

INSERT INTO provider_egress_policy_versions (
  policy_version,
  provider,
  role,
  model_config_version,
  consent_policy_version,
  status
)
VALUES (
  'deepseek-conversation-text:v1',
  'deepseek',
  'conversation.text',
  'conversation-text-champion:v1',
  NULL,
  'active'
);
