-- G1 generation v4 pins low reasoning effort at the existing 10000-token cap.
-- Hosted daily generation exhausted v3 before completing typed output.
-- Preserve immutable prior configuration and egress policy history.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-episode.build-egress:g1-release:v4', 'deepseek',
   'episode.build', 'episode.build:g1-release:v4', NULL, 'active'),
  ('deepseek-reflection.daily-egress:g1-release:v4', 'deepseek',
   'reflection.daily', 'reflection.daily:g1-release:v4', NULL, 'active'),
  ('deepseek-reflection.weekly-egress:g1-release:v4', 'deepseek',
   'reflection.weekly', 'reflection.weekly:g1-release:v4', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
