-- Real Provider preflight exhausted the old 4000-token budgets before producing
-- visible output. Episode and Reflection use new immutable v3 configurations
-- for 10000-token budgets and complete output-schema prompts. Keep v2 rows for
-- rollback history. Activation remains gated by a verified release manifest.
INSERT INTO provider_egress_policy_versions (
  policy_version, provider, role, model_config_version,
  consent_policy_version, status
)
VALUES
  ('deepseek-episode.build-egress:g1-release:v3', 'deepseek',
   'episode.build', 'episode.build:g1-release:v3', NULL, 'active'),
  ('deepseek-reflection.daily-egress:g1-release:v3', 'deepseek',
   'reflection.daily', 'reflection.daily:g1-release:v3', NULL, 'active'),
  ('deepseek-reflection.weekly-egress:g1-release:v3', 'deepseek',
   'reflection.weekly', 'reflection.weekly:g1-release:v3', NULL, 'active')
ON CONFLICT (policy_version) DO NOTHING;
